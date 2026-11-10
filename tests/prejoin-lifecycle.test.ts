import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import {
  type InviteDeps,
  inviteFor,
  inviteIntentProvider,
  receiveInvite,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { knockRemote } from '#engine/federation/knocks.ts';
import { admitLocalJoin } from '#engine/room/hooks.ts';
import { roomSchema } from '#engine/room/index.ts';
import { installJoinAdmission } from '#engine/server/join-attempts.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  eventStreamMax,
  eventStreamTx,
  nextEventSeq,
} from '#engine/server/stream.ts';
import { openStore } from '#engine/store/index.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { createFakeRoom } from '#tests/federation/fake-room.ts';
import { fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';

async function fixture(
  run: (f: {
    deps: InviteDeps;
    roomId: string;
    user: string;
    origin: string;
    publish: () => Promise<number>;
    reject: () => Promise<void>;
    sent: Promise<void>;
    finish: () => void;
  }) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  let signal!: () => void;
  let finish!: () => void;
  const sent = new Promise<void>((r) => signal = r);
  const gate = new Promise<void>((r) => finish = r);
  let room: Awaited<ReturnType<typeof createFakeRoom>>;
  const us = await testRemoteServer('test');
  const fake = await startFakeServer({
    ourKeyDoc: async () => ({
      server_name: 'test',
      verify_keys: {
        [us.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey)),
        },
      },
    }),
    handlers: async (req) => {
      if (req.url.pathname.includes('/make_leave/')) {
        return Response.json(room.makeLeaveTemplate('@dev:test'));
      }
      if (req.url.pathname.includes('/send_leave/')) {
        signal();
        await gate;
        return Response.json({});
      }
      if (req.url.pathname.includes('/make_knock/')) {
        return Response.json({
          room_version: '11',
          event: {
            ...room.makeLeaveTemplate('@dev:test').event as Record<
              string,
              unknown
            >,
            content: { membership: 'knock' },
          },
        });
      }
      if (req.url.pathname.includes('/send_knock/')) {
        return Response.json({ knock_room_state: [] });
      }
      return new Response('', { status: 404 });
    },
  });
  try {
    room = await createFakeRoom({
      version: '11',
      creator: '@owner:' + fake.name,
      server: { name: fake.name, keyId: fake.keyId, kp: fake.kp },
    });
    const user = '@dev:test';
    const server = await store.server();
    const deps: InviteDeps = {
      store,
      server,
      signer: await testSigner(),
      keys: fakeKeyResolver(fake),
      self: 'test',
      wake: () => {},
    };
    installJoinAdmission(store);
    const invite = await room.addEvent({
      type: 'm.room.member',
      sender: '@owner:' + fake.name,
      state_key: user,
      content: { membership: 'invite' },
    });
    await receiveInvite(
      room.roomId,
      String(invite.event_id),
      { room_version: '11', event: room.wire(invite), invite_room_state: [] },
      fake.name,
      deps,
    );
    const publish = () =>
      eventStreamTx(server, async (tx) => {
        const seq = await nextEventSeq(tx);
        await tx.execute(
          "INSERT INTO memberships(room,user,membership,event,seq) VALUES(?,?,'leave','$published',?) ON CONFLICT(room,user) DO UPDATE SET membership='leave',seq=excluded.seq",
          [room.roomId, user, seq],
        );
        return seq;
      });
    await run({
      deps,
      roomId: room.roomId,
      user,
      origin: fake.name,
      publish,
      reject: () => rejectInviteRemote(room.roomId, user, deps),
      sent,
      finish,
    });
  } finally {
    finish();
    await fake.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

Deno.test('prejoin: late rejection completion cannot overtake a room publication', () =>
  fixture(async (f) => {
    await f.reject();
    const job = await inviteIntentProvider(f.deps)(f.deps.server, f.origin);
    assert(job);
    const running = job.run();
    await f.sent;
    const cut = await f.publish();
    await assertRejects(() => admitLocalJoin(f.deps.store, f.roomId, f.user));
    f.finish();
    await running;
    assertEquals(await eventStreamMax(f.deps.server), cut);
    assertEquals(await inviteFor(f.roomId, f.user, f.deps), null);
    await admitLocalJoin(f.deps.store, f.roomId, f.user);
  }));

Deno.test('prejoin: superseded unsent rejection is settled without blocking admission', () =>
  fixture(async (f) => {
    await f.reject();
    const cut = await f.publish();
    await admitLocalJoin(f.deps.store, f.roomId, f.user);
    assertEquals(await eventStreamMax(f.deps.server), cut);
    assertEquals(
      await inviteIntentProvider(f.deps)(f.deps.server, f.origin),
      null,
    );
  }));

Deno.test('prejoin: a hidden revision does not prevent a fresh remote knock', () =>
  fixture(async (f) => {
    await f.publish();
    const result = await knockRemote(f.roomId, f.user, {}, [f.origin], f.deps);
    assertEquals(result.roomId, f.roomId);
    const current = await inviteFor(f.roomId, f.user, f.deps);
    assertEquals(current?.revision, 2);
    assertEquals(current?.status, 'pending');
  }));
