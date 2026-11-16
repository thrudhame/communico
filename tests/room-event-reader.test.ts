import { assertEquals, assertRejects } from '@std/assert';
import {
  initializeRoom,
  openRoom,
  type Room,
  roomSchema,
  type RoomTx,
} from '#engine/room/index.ts';
import { Conn } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';
import { openStore, type Store } from '#engine/store/index.ts';

const pdu = (body: string) =>
  JSON.stringify({
    type: 'm.room.message',
    sender: '@dev:test',
    depth: 1,
    origin_server_ts: 1,
    content: { body },
    prev_events: [],
    auth_events: [],
  });
async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
async function withRoom(fn: (room: Room) => Promise<void>) {
  await withStore(async (store) =>
    await fn(await openRoom(store, '!reader:test', { create: true }))
  );
}

Deno.test('event reader: scalar and bulk requests share one hydration and return isolated rows', async () => {
  await withRoom(async (room) => {
    await room.tx(async (tx) => {
      for (const id of ['$a', '$b', '$c', '$d']) {
        await tx.events.insert(id, pdu(id));
      }
    });
    const original = Conn.prototype.query;
    let reads = 0;
    Conn.prototype.query = function (sql, values) {
      if (sql.startsWith('SELECT * FROM events WHERE id')) reads++;
      return original.call(this, sql, values);
    };
    try {
      await room.tx(async (tx) => {
        const [a, duplicate, batch] = await Promise.all([
          tx.events.get('$a'),
          tx.events.get('$a'),
          tx.events.list(['$a', '$b', '$a']),
        ]);
        assertEquals(reads, 2);
        assertEquals(a, duplicate);
        a!.pdu = 'mutated';
        duplicate!.sender = 'mutated';
        batch.get('$a')!.type = 'mutated';
        batch.clear();
        assertEquals((await tx.events.get('$a'))!.pdu, pdu('$a'));
        assertEquals(
          (await tx.events.list(['$a', '$b'])).get('$a')!.sender,
          '@dev:test',
        );
        assertEquals(reads, 2);
        const [bulk, c, d] = await Promise.all([
          tx.events.list(['$c', '$d']),
          tx.events.get('$c'),
          tx.events.get('$d'),
        ]);
        assertEquals(reads, 3);
        assertEquals(bulk.get('$c'), c);
        assertEquals(bulk.get('$d'), d);
      });
    } finally {
      Conn.prototype.query = original;
    }
  });
});

Deno.test('event reader: misses, failed reads and mutable status remain fresh', async () => {
  await withRoom(async (room) => {
    await room.tx(async (tx) => {
      assertEquals(await tx.events.get('$later'), null);
      assertEquals(await tx.events.list(['$later']), new Map());
      await tx.events.insert('$later', pdu('inserted after miss'));
      assertEquals(
        (await tx.events.get('$later'))!.pdu,
        pdu('inserted after miss'),
      );
      await tx.events.setStatus('$later', {
        standing: 'accepted',
        grounding: 'grounded',
        origin: null,
        received_ts: 1,
      });
      assertEquals((await tx.events.getStatus('$later'))!.standing, 'accepted');
      await tx.events.setStatus('$later', {
        standing: 'rejected',
        grounding: 'evidence',
        origin: null,
        received_ts: 2,
      });
      assertEquals((await tx.events.getStatus('$later'))!.standing, 'rejected');
      assertEquals(
        (await tx.events.get('$later'))!.pdu,
        pdu('inserted after miss'),
      );
      await tx.events.insert('$fault', pdu('after fault'));
      const original = Conn.prototype.query;
      let fail = true;
      Conn.prototype.query = function (sql, values) {
        if (fail && sql.startsWith('SELECT * FROM events WHERE id')) {
          fail = false;
          return Promise.reject(new Error('injected event read fault'));
        }
        return original.call(this, sql, values);
      };
      try {
        await assertRejects(
          () => tx.events.list(['$fault']),
          Error,
          'injected event read fault',
        );
        assertEquals((await tx.events.get('$fault'))!.pdu, pdu('after fault'));
      } finally {
        Conn.prototype.query = original;
      }
    });
  });
});

Deno.test('event reader: rollback and native retry receive fresh readers and release escaped capabilities', async () => {
  await withRoom(async (room) => {
    let escaped!: RoomTx;
    await assertRejects(
      () =>
        room.tx(async (tx) => {
          escaped = tx;
          await tx.events.insert('$rollback', pdu('abandoned'));
          await tx.events.get('$rollback');
          throw new Error('rollback event attempt');
        }),
      Error,
      'rollback event attempt',
    );
    await assertRejects(
      () => escaped.events.get('$rollback'),
      Error,
      'released',
    );
    await assertRejects(
      () => escaped.events.list(['$rollback']),
      Error,
      'released',
    );
    await room.tx(async (tx) => {
      assertEquals(await tx.events.get('$rollback'), null);
    });
    const commit = Turso.prototype.commit;
    let calls = 0, attempts = 0;
    const readers: RoomTx[] = [];
    Turso.prototype.commit = function (handle) {
      if (++calls === 1) {
        return Promise.reject(new StoreError(517, 'snapshot', 'BusySnapshot'));
      }
      return commit.call(this, handle);
    };
    try {
      const value = await room.tx(async (tx) => {
        readers.push(tx);
        const body = 'attempt' + ++attempts;
        assertEquals(await tx.events.get('$retry'), null);
        await tx.events.insert('$retry', pdu(body));
        return (await tx.events.get('$retry'))!.pdu;
      });
      assertEquals(attempts, 2);
      assertEquals(value, pdu('attempt2'));
    } finally {
      Turso.prototype.commit = commit;
    }
    for (const tx of readers) {
      await assertRejects(() => tx.events.get('$retry'), Error, 'released');
      await assertRejects(() => tx.events.list(['$retry']), Error, 'released');
    }
    assertEquals(
      await room.tx(async (tx) => (await tx.events.get('$retry'))!.pdu),
      pdu('attempt2'),
    );
  });
});

Deno.test('event reader: room and store identity never share immutable rows', async () => {
  await withRoom(async (first) => {
    const second = await openRoom(first.store, '!other:test', { create: true });
    await first.tx(async (tx) => {
      await tx.events.insert('$same', pdu('first room'));
    });
    await second.tx(async (tx) => {
      await tx.events.insert('$same', pdu('second room'));
    });
    assertEquals(
      await first.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
      pdu('first room'),
    );
    assertEquals(
      await second.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
      pdu('second room'),
    );
    await withRoom(async (otherStore) => {
      await otherStore.tx(async (tx) => {
        await tx.events.insert('$same', pdu('other store'));
      });
      assertEquals(
        await otherStore.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
        pdu('other store'),
      );
    });
    assertEquals(
      await first.tx(async (tx) => (await tx.events.get('$same'))!.pdu),
      pdu('first room'),
    );
  });
});

Deno.test('event reader: unpublished initialization shares and releases its reader', async () => {
  await withStore(async (store) => {
    let escaped!: RoomTx;
    await initializeRoom(store, '!initial:test', async (tx) => {
      escaped = tx;
      await tx.events.insert('$initial', pdu('initialized'));
      const row = await tx.events.get('$initial');
      row!.pdu = 'mutated';
      assertEquals(
        (await tx.events.list(['$initial'])).get('$initial')!.pdu,
        pdu('initialized'),
      );
    });
    await assertRejects(
      () => escaped.events.get('$initial'),
      Error,
      'released',
    );
    await assertRejects(
      () => escaped.events.list(['$initial']),
      Error,
      'released',
    );
    const room = await openRoom(store, '!initial:test');
    assertEquals(
      await room.tx(async (tx) => (await tx.events.get('$initial'))!.pdu),
      pdu('initialized'),
    );
  });
});
