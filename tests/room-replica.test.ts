import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  importReplicaBoundary,
  importReplicaGenesis,
} from '#engine/room/replica.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { openStore } from '#engine/store/index.ts';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';

async function fixture() {
  const source = await makeFakeRoom({ roomId: '!replica:remote.test' });
  const home = await makeRemoteServer('logical.test');
  const template = source.makeJoinAnswer('@alice:logical.test').event;
  const join = await remoteEvent(source.roomId, home, source.version, {
    ...template,
    sender: '@alice:logical.test',
    prev_events: template.prev_events ?? [],
  });
  const answer = await source.acceptSendJoin(join);
  const dir = await Deno.makeTempDir({ prefix: 'room-replica-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  return {
    store,
    source,
    join,
    input: {
      roomId: source.roomId,
      roomVersion: source.version,
      self: 'logical.test',
      resident: source.server.name,
      keys: fakeKeyResolver(source.server, home),
      join: answer.event,
      state: answer.state,
      authChain: answer.authChain,
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('replica imports the authentic local participation boundary without minting a new join or copying state IDs', async () => {
  const f = await fixture();
  try {
    const imported = await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const first = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      assert(stay);
      assertEquals(stay.opened_by, f.join.event_id);
      assertEquals(
        (await tx.events.get(String(f.join.event_id)))!.pdu,
        canonicalJson(f.input.join),
      );
      const before = await tx.state.eventStateBefore(String(f.join.event_id));
      assert(before !== null);
      assertEquals(before.provenance, 'imported');
      assertEquals(
        await tx.state.groupMap(before.group),
        new Map(
          f.input.state.map((
            event,
          ) => [event.type + '\0' + event.state_key, String(event.event_id)]),
        ),
      );
      assertEquals(
        (await tx.events.getStatus(String(f.join.event_id)))?.grounding,
        'grounded',
      );
      return { changes: await tx.changes.head(), stay: stay.id };
    });
    assertEquals(imported.eventId, f.join.event_id);
    await importReplicaBoundary(f.store, f.input);
    assertEquals(
      await room.tx(async (tx) => ({
        changes: await tx.changes.head(),
        stay: (await tx.segments.openStay())!.id,
      })),
      first,
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica refuses unsigned own joins, non-local participation and missing closure before creating a room', async () => {
  const f = await fixture();
  try {
    await assertRejects(() =>
      importReplicaBoundary(f.store, {
        ...f.input,
        join: { ...f.input.join, signatures: {} },
      })
    );
    await assertRejects(() =>
      importReplicaBoundary(f.store, {
        ...f.input,
        join: {
          ...f.input.join,
          signatures: {
            [f.source.server.name]:
              f.input.join.signatures![f.source.server.name],
          },
        },
      })
    );
    await assertRejects(
      () =>
        importReplicaBoundary(f.store, { ...f.input, self: 'unrelated.test' }),
      MatrixError,
      'local participation',
    );
    await assertRejects(
      () =>
        importReplicaBoundary(f.store, {
          ...f.input,
          state: f.input.state.filter((pdu) => pdu.type !== 'm.room.create'),
        }),
      MatrixError,
    );
    await assertRejects(
      () => openRoom(f.store, f.source.roomId),
      Deno.errors.NotFound,
    );
  } finally {
    await f.close();
  }
});

Deno.test('a signed participation event still needs authorization against its imported before-state', async () => {
  const f = await fixture();
  try {
    const ban = await f.source.addEvent({
      type: 'm.room.member',
      state_key: '@alice:logical.test',
      content: { membership: 'ban' },
    });
    await assertRejects(
      () =>
        importReplicaBoundary(f.store, {
          ...f.input,
          state: [
            ...f.input.state.filter((pdu) =>
              !(pdu.type === 'm.room.member' &&
                pdu.state_key === '@alice:logical.test')
            ),
            ban,
          ],
          authChain: [...f.source.events.values()],
        }),
      MatrixError,
      'snapshot state',
    );
    await assertRejects(
      () => openRoom(f.store, f.source.roomId),
      Deno.errors.NotFound,
    );
  } finally {
    await f.close();
  }
});

Deno.test('home-created replica genesis replays the original create and creator join through normal DAG state', async () => {
  const f = await fixture();
  try {
    const home = await makeRemoteServer('logical.test');
    const source = await makeFakeRoom({
      roomId: '!local:logical.test',
      server: home,
    });
    const create = source.events.get(source.createId)!;
    const join = [...source.events.values()].find((pdu) =>
      pdu.type === 'm.room.member'
    )!;
    const input = {
      roomId: source.roomId,
      roomVersion: source.version,
      self: home.name,
      keys: fakeKeyResolver(home),
      create,
      join,
    };
    await importReplicaGenesis(f.store, input);
    const room = await openRoom(f.store, source.roomId);
    const read = () =>
      room.tx(async (tx) => {
        assertEquals(
          (await tx.state.eventStateBefore(source.createId))?.provenance,
          'dag',
        );
        const before = await tx.state.eventStateBefore(String(join.event_id));
        assert(before);
        assertEquals(before.provenance, 'dag');
        assertEquals(
          await tx.state.groupMap(before.group),
          new Map([['m.room.create\0', source.createId]]),
        );
        assert(await tx.segments.positionOf(source.createId));
        assert(await tx.segments.positionOf(String(join.event_id)));
        return await tx.changes.head();
      });
    const before = await read();
    await importReplicaGenesis(f.store, input);
    assertEquals(await read(), before);
  } finally {
    await f.close();
  }
});
