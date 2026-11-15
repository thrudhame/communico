import { assertEquals, assertRejects } from '@std/assert';
import { openRoom, roomSchema, type RoomTx } from '#engine/room/index.ts';
import { Conn } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';

async function withRoom(
  fn: (room: Awaited<ReturnType<typeof openRoom>>) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await fn(await openRoom(store, '!reader:test', { create: true }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const entry = (event: string | null) => ({
  type: 'test',
  state_key: '',
  event,
});

Deno.test('state reader: sibling maps share ancestors and return isolated values', async () => {
  await withRoom(async (room) => {
    const original = Conn.prototype.query;
    let reads = 0;
    Conn.prototype.query = function (sql, values) {
      if (/FROM state_(groups|entries)/.test(sql)) reads++;
      return original.call(this, sql, values);
    };
    try {
      await room.tx(async (tx) => {
        const base = await tx.materialize.newGroup(null, [entry('$base')]);
        const left = await tx.materialize.newGroup(base, [entry('$left')]);
        const right = await tx.materialize.newGroup(base, [entry(null)]);
        reads = 0;
        const [a, b, duplicate] = await Promise.all([
          tx.state.groupMap(left),
          tx.state.groupMap(right),
          tx.state.groupMap(left),
        ]);
        assertEquals(
          reads,
          6,
          'each actual group and its entries is read once',
        );
        assertEquals(a, new Map([['test\0', '$left']]));
        assertEquals(b, new Map());
        a.clear();
        duplicate.set('injected\0', '$not-state');
        const entries = await tx.state.groupEntries(left);
        entries[0].event = '$not-state';
        assertEquals(
          await tx.state.groupMap(left),
          new Map([['test\0', '$left']]),
        );
        assertEquals(await tx.state.groupKey(left, 'test', ''), '$left');
        assertEquals(await tx.state.groupKey(right, 'test', ''), null);
        assertEquals(reads, 6);
      });
    } finally {
      Conn.prototype.query = original;
    }
  });
});

Deno.test('state reader: misses and failed reads do not become cached facts', async () => {
  await withRoom(async (room) => {
    await room.tx(async (tx) => {
      await assertRejects(
        () => tx.state.groupMap(1),
        Error,
        'unknown state group',
      );
      const group = await tx.materialize.newGroup(null, [entry('$created')]);
      assertEquals(group, 1);
      const original = Conn.prototype.query;
      let fail = true;
      Conn.prototype.query = function (sql, values) {
        if (fail && sql.includes('FROM state_entries WHERE grp = ?')) {
          fail = false;
          return Promise.reject(new Error('injected state read fault'));
        }
        return original.call(this, sql, values);
      };
      try {
        await assertRejects(
          () => tx.state.groupEntries(group),
          Error,
          'injected state read fault',
        );
        assertEquals(
          await tx.state.groupMap(group),
          new Map([['test\0', '$created']]),
        );
      } finally {
        Conn.prototype.query = original;
      }
    });
  });
});

Deno.test('state reader: rollback and escaped handles cannot reuse an attempt', async () => {
  await withRoom(async (room) => {
    let escaped!: RoomTx;
    let abandoned!: number;
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          escaped = tx;
          abandoned = await tx.materialize.newGroup(null, [
            entry('$abandoned'),
          ]);
          assertEquals(
            await tx.state.groupKey(abandoned, 'test', ''),
            '$abandoned',
          );
          await tx.state.groupMap(abandoned);
          throw new Error('rollback this attempt');
        }),
      Error,
      'rollback this attempt',
    );
    for (
      const read of [
        () => escaped.state.groupMap(abandoned),
        () => escaped.state.groupEntries(abandoned),
        () => escaped.state.groupKey(abandoned, 'test', ''),
      ]
    ) await assertRejects(read, Error, 'released');
    await room.tx(async (tx) => {
      await assertRejects(
        () => tx.state.groupMap(abandoned),
        Error,
        'unknown state group',
      );
      const group = await tx.materialize.newGroup(null, [entry('$committed')]);
      assertEquals(
        await tx.state.groupMap(group),
        new Map([['test\0', '$committed']]),
      );
      escaped = tx;
      abandoned = group;
    });
    await assertRejects(
      () => escaped.state.groupMap(abandoned),
      Error,
      'released',
    );
  });
});
