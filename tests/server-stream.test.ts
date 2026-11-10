import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  acceptRescind,
  type InviteDeps,
  inviteFor,
  markInviteJoined,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { project } from '#engine/server/project.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  eventStreamMax,
  eventStreamTx,
  nextEventSeq,
} from '#engine/server/stream.ts';
import { openStore } from '#engine/store/index.ts';
import { genesis } from '#tests/fixtures/genesis.ts';
import {
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from '#tests/fixtures/remote.ts';

Deno.test('event stream: room publications and every OOB transition share durable transactional cuts', async () => {
  const dir = await Deno.makeTempDir();
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(config, { schemas });
  try {
    const g = await genesis(store, { roomId: '!stream:test' });
    await project(store, g.roomId);
    const server = await store.server();
    assertEquals(await eventStreamMax(server), 5);
    const remote = await makeRemoteServer('remote.test');
    const deps: InviteDeps = {
      store,
      server,
      signer: g.signer,
      keys: fakeKeyResolver(remote),
      self: 'test',
      wake: () => {},
    };
    const roomId = '!invite:remote.test';
    const user = '@dev:test';
    let invite = await remoteEvent(roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@zoe:remote.test',
      state_key: user,
      content: { membership: 'invite', is_direct: true },
      prev_events: ['$unknown'],
      auth_events: [],
    });
    const receive = () =>
      receiveInvite(
        roomId,
        invite.event_id!,
        {
          room_version: '11',
          event: wireOf(invite),
          invite_room_state: [],
        },
        remote.name,
        deps,
      );
    await receive();
    assertEquals((await inviteFor(roomId, user, deps))?.seq, 6);
    assertEquals(await eventStreamMax(server), 6);
    await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { body: 'after invite' },
      origin_server_ts: 100,
    }, g.signer);
    await project(store, g.roomId);
    assertEquals(await eventStreamMax(server), 7);
    assertEquals(
      await server.query('SELECT seq FROM feed ORDER BY seq'),
      [1, 2, 3, 4, 5, 7].map((seq) => ({ seq })),
    );
    await project(store, g.roomId);
    assertEquals(await eventStreamMax(server), 7, 'replay allocates nothing');
    await rejectInviteRemote(roomId, user, deps);
    assertEquals((await inviteFor(roomId, user, deps))?.seq, 8);
    const leave = await remoteEvent(roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@zoe:remote.test',
      state_key: user,
      content: { membership: 'leave' },
      prev_events: [invite.event_id!],
      auth_events: [],
    });
    assert(await acceptRescind(roomId, leave, deps));
    assertEquals((await inviteFor(roomId, user, deps))?.seq, 9);
    await receive();
    assertEquals(
      await eventStreamMax(server),
      9,
      'withdrawn invite replay is inert',
    );
    assertEquals((await inviteFor(roomId, user, deps))?.status, 'rejected');
    invite = await remoteEvent(roomId, remote, '11', {
      type: 'm.room.member',
      sender: '@zoe:remote.test',
      state_key: user,
      content: { membership: 'invite', is_direct: true },
      prev_events: [leave.event_id!],
      auth_events: [],
    });
    await receive();
    await markInviteJoined(roomId, user, deps);
    const accepted = await inviteFor(roomId, user, deps);
    assertEquals(accepted?.seq, 11);
    assertEquals(accepted?.status, 'joined');
    await markInviteJoined(roomId, user, deps);
    assertEquals(await eventStreamMax(server), 11, 'no transition, no cursor');
    await assertRejects(
      () =>
        eventStreamTx(server, async (tx) => {
          const seq = await nextEventSeq(tx);
          await tx.execute(
            'UPDATE prejoin_memberships SET seq = ?, status = ? WHERE room_id = ?',
            [seq, 'rejected', roomId],
          );
          throw new Error('abort transition');
        }),
      Error,
      'abort transition',
    );
    assertEquals(await eventStreamMax(server), 11);
    assertEquals(await inviteFor(roomId, user, deps), accepted);
    const positions = await Promise.all(
      Array.from(
        { length: 12 },
        () => eventStreamTx(server, (tx) => nextEventSeq(tx)),
      ),
    );
    assertEquals(positions, Array.from({ length: 12 }, (_, n) => n + 12));
    await store.close();
    store = await openStore(config, { schemas });
    assertEquals(await eventStreamMax(await store.server()), 23);
    assertEquals(
      (await inviteFor(roomId, user, {
        ...deps,
        store,
        server: await store.server(),
      }))?.seq,
      11,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
