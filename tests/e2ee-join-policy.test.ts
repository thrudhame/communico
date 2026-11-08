import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { joinRemote } from '#engine/room/join.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { fakeFetcher, fakeKeyResolver } from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import {
  beginJoinAttempt,
  clearJoinAttempt,
  type JoinAttempt,
  pendingJoinAttempts,
  releaseJoinAttempt,
} from '#engine/server/join-attempts.ts';
import {
  type InviteDeps,
  inviteIntentProvider,
} from '#engine/federation/invites.ts';
import {
  joinCleanupProvider,
  performJoinCleanup,
} from '#engine/federation/join-cleanup.ts';
import { startSender } from '#engine/federation/sender.ts';
import { startFakeServer } from './federation/fake-server.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { assertAuthored } from './fixtures/authored.ts';
import type { Pdu } from '#engine/pdu.ts';
import { join, leave, reopen } from '#engine/room/membership.ts';
import { createRoom } from '#engine/room/create.ts';
import { buildInTx } from '#engine/room/build.ts';
import { ingestLocal, sendLocal } from '#engine/room/ingest.ts';

Deno.test('E6 pending remote cleanup blocks every local join authoring boundary until leave acknowledgment', async () => {
  const old = config();
  setConfigForTests({ encryption: { allowunencryptedcreation: false } });
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    const signer = await testSigner();
    const created = await createRoom(store, {
      creator: '@owner:test',
      preset: 'public_chat',
    }, signer);
    const room = await openRoom(store, created.roomId);
    const partial = {
      type: 'm.room.member',
      state_key: '@anna:test',
      sender: '@anna:test',
      content: { membership: 'join' },
    };
    const pdu = await room.tx((tx) => buildInTx(tx, room.id, partial, signer));
    const attempt: JoinAttempt = {
      roomId: room.id,
      userId: partial.sender,
      eventId: '$uncommitted',
      roomVersion: '11',
      destination: 'remote.test',
      addedMs: Date.now(),
    };
    await beginJoinAttempt(store, attempt);
    releaseJoinAttempt(store, attempt);
    for (
      const author of [
        () => join(room, partial.sender, signer),
        () => sendLocal(room, partial, signer),
        () => ingestLocal(room, pdu, 'test'),
      ]
    ) await assertRejects(author, MatrixError, 'cleanup is pending');
    assertEquals(
      await room.tx((tx) => tx.events.get(String(pdu.event_id))),
      null,
    );
    await leave(room, '@owner:test', signer);
    await assertRejects(
      () => reopen(room, partial.sender, signer, {}),
      MatrixError,
      'cleanup is pending',
    );
    const deps: InviteDeps = {
      store,
      server: await store.server(),
      signer,
      keys: fakeKeyResolver(remote),
      self: 'test',
      wake: () => {},
    };
    const provider = joinCleanupProvider(deps, inviteIntentProvider(deps));
    assertEquals((await provider.review()).length, 1);
    await clearJoinAttempt(deps.server, attempt);
    assertEquals(
      (await reopen(room, partial.sender, signer, {})).created,
      true,
    );
    await assertRejects(
      () => beginJoinAttempt(store, attempt),
      MatrixError,
      'Already joined locally',
    );
    assertEquals(await pendingJoinAttempts(deps.server), []);
  } finally {
    await store.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E6 unknown plaintext remote join refuses local publication and leaves the remote membership', async () => {
  const old = config();
  setConfigForTests({ encryption: { allowunencryptedjoining: false } });
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    const fr = await makeFakeRoom({ roomId: '!strict:remote.test' });
    const user = '@anna:test';
    let remoteMembership = 'leave';
    const { fetcher } = fakeFetcher({
      makeJoin: (u) => fr.makeJoinAnswer(u),
      sendJoin: async (pdu) => {
        remoteMembership = 'join';
        return await fr.acceptSendJoin(pdu);
      },
    });
    await assertRejects(
      () =>
        joinRemote(store, {
          roomId: fr.roomId,
          user,
          via: [fr.server.name],
          signer: awaitSigner!,
          deps: {
            self: 'test',
            fetcher,
            keys: fakeKeyResolver(fr.server, remote!),
            leave: () => {
              remoteMembership = 'leave';
              return Promise.resolve();
            },
          },
        }),
      MatrixError,
      'Joining unencrypted rooms is disabled',
    );
    assertEquals(remoteMembership, 'leave');
    await assertRejects(() => openRoom(store, fr.roomId), Deno.errors.NotFound);
  } finally {
    setConfigForTests(old);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

const awaitSigner = await testSigner();
const remote = await testRemoteServer();

Deno.test('E6 real server v12 upgrade adds empty cleanup state and preserves accepted reliable work', async () => {
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, {
    schemas: {
      server: {
        version: 12,
        apply: async (db) => {
          await serverSchema.apply(db);
          await db.exec('DROP TABLE federation_join_attempts');
        },
      },
    },
  });
  try {
    await (await store.server()).execute(
      "INSERT INTO edu_outbox(source,destination,edu_type,payload,state,enqueue_pos) VALUES('accepted','peer','m.direct_to_device','{}','pending',41)",
    );
    await store.close();
    store = await openStore(settings, { schemas: { server: serverSchema } });
    const server = await store.server();
    assertEquals(await pendingJoinAttempts(server), []);
    assertEquals(
      await server.query('SELECT source,state,enqueue_pos FROM edu_outbox'),
      [{ source: 'accepted', state: 'pending', enqueue_pos: 41 }],
    );
    assertEquals(
      (await server.query("SELECT v FROM meta WHERE k='schema_version'"))[0].v,
      '13',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E6 encrypted import survives cleanup acknowledgment failure; active and committed joins never get compensated', async () => {
  const old = config();
  setConfigForTests({ encryption: { allowunencryptedjoining: false } });
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    const signer = await testSigner();
    const fr = await makeFakeRoom({ roomId: '!encrypted:remote.test' });
    await fr.addEvent({
      type: 'm.room.encryption',
      state_key: '',
      content: { algorithm: 'm.megolm.v1.aes-sha2' },
    });
    const server = await store.server();
    const deps: InviteDeps = {
      store,
      server,
      signer,
      keys: fakeKeyResolver(fr.server, remote),
      self: 'test',
      wake: () => {},
    };
    const provider = joinCleanupProvider(deps, inviteIntentProvider(deps));
    let leaveCalls = 0;
    const { fetcher } = fakeFetcher({
      makeJoin: (u) => fr.makeJoinAnswer(u),
      sendJoin: async (pdu) => {
        assertEquals(
          await provider(server, fr.server.name),
          null,
          'in-flight join cannot be cleaned',
        );
        await server.exec(
          "CREATE TRIGGER fail_cleanup BEFORE DELETE ON federation_join_attempts BEGIN SELECT RAISE(ABORT,'ack unavailable'); END",
        );
        return await fr.acceptSendJoin(pdu);
      },
    });
    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: '@anna:test',
      via: [fr.server.name],
      signer,
      deps: {
        self: 'test',
        keys: deps.keys,
        fetcher,
        leave: () => {
          leaveCalls++;
          return Promise.resolve();
        },
      },
    });
    assertEquals((await pendingJoinAttempts(server)).length, 1);
    const room = await openRoom(store, fr.roomId);
    assertEquals(
      (await room.tx((tx) => tx.events.getStatus(result.eventId)))?.standing,
      'accepted',
    );
    await server.exec('DROP TRIGGER fail_cleanup');
    await store.close();
    store = await openStore(settings, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    const reopened = await store.server();
    const nextDeps = { ...deps, store, server: reopened };
    const next = joinCleanupProvider(nextDeps, inviteIntentProvider(nextDeps));
    const job = await next(reopened, fr.server.name);
    assert(job);
    await job.run(); // No network/leave is possible for this nonresolving peer.
    assertEquals(await pendingJoinAttempts(reopened), []);
    assertEquals(leaveCalls, 0);
    assertEquals(
      (await openRoom(store, fr.roomId).then((r) =>
        r.tx((tx) => tx.segments.openStay())
      )) !== null,
      true,
    );
  } finally {
    await store.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E6 known archived plaintext room refuses before a new remote handshake', async () => {
  const old = config();
  setConfigForTests({ encryption: { allowunencryptedjoining: true } });
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  try {
    const fr = await makeFakeRoom({ roomId: '!archived:remote.test' });
    const signer = await testSigner();
    const { fetcher, calls } = fakeFetcher({
      makeJoin: (u) => fr.makeJoinAnswer(u),
      sendJoin: (pdu) => fr.acceptSendJoin(pdu),
    });
    const args = {
      roomId: fr.roomId,
      user: '@anna:test',
      via: [fr.server.name],
      signer,
      deps: { self: 'test', fetcher, keys: fakeKeyResolver(fr.server, remote) },
    };
    await joinRemote(store, args);
    await leave(await openRoom(store, fr.roomId), args.user, signer);
    setConfigForTests({ encryption: { allowunencryptedjoining: false } });
    await assertRejects(
      () => joinRemote(store, args),
      MatrixError,
      'Joining unencrypted rooms is disabled',
    );
    assertEquals(calls.makeJoin.length, 1);
    assertEquals(calls.sendJoin.length, 1);
    assertEquals(await pendingJoinAttempts(await store.server()), []);
  } finally {
    await store.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('E6 interrupted send_join retains visible cleanup across reopen; sender performs a signed remote leave', async () => {
  const old = config();
  setConfigForTests({
    encryption: { allowunencryptedjoining: false },
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, {
    schemas: { room: roomSchema, server: serverSchema },
  });
  const signer = await testSigner();
  const user = '@anna:test';
  const fr = await makeFakeRoom({ roomId: '!interrupted:remote.test' });
  let membership = 'leave';
  let leaveCalls = 0;
  let v2Calls = 0;
  const fake = await startFakeServer({
    ourKeyDoc: async () => ({
      server_name: remote.name,
      verify_keys: {
        [remote.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(remote.kp.publicKey)),
        },
      },
    }),
    handlers: (req) => {
      if (req.url.pathname.includes('/make_leave/')) {
        return Response.json({
          room_version: '11',
          event: fr.makeJoinAnswer(user).event,
        });
      }
      if (req.url.pathname.includes('/send_leave/')) {
        return (async () => {
          assert(
            req.verified,
            'remote cleanup must use signed federation transport',
          );
          if (req.url.pathname.includes('/v2/')) {
            v2Calls++;
            return Response.json({ errcode: 'M_UNRECOGNIZED' }, {
              status: 404,
            });
          }
          const pdu = req.json() as Pdu;
          await assertAuthored(pdu);
          assertEquals(pdu.content.membership, 'leave');
          assertEquals(pdu.sender, user);
          membership = 'leave';
          leaveCalls++;
          if (leaveCalls === 1) {
            return Response.json({ error: 'ack lost after remote leave' }, {
              status: 503,
            });
          }
          return Response.json([200, {}]);
        })();
      }
      return null;
    },
  });
  let sender: ReturnType<typeof startSender> | undefined;
  try {
    const { fetcher, calls } = fakeFetcher({
      makeJoin: (u) => fr.makeJoinAnswer(u),
      sendJoin: async (pdu) => {
        assertEquals(
          (await pendingJoinAttempts(await store.server())).length,
          1,
          'intent precedes remote effect',
        );
        membership = 'join';
        await fr.acceptSendJoin(pdu);
        throw new Error('connection lost after remote commit');
      },
    });
    const args = {
      roomId: fr.roomId,
      user,
      via: [fake.name],
      signer,
      deps: {
        self: 'test',
        fetcher,
        keys: fakeKeyResolver(fr.server, remote),
        leave: async (attempt: JoinAttempt) =>
          performJoinCleanup({ server: await store.server(), signer }, attempt),
      },
    };
    await assertRejects(
      () => joinRemote(store, args),
      Error,
      'connection lost',
    );
    assertEquals(membership, 'leave');
    assertEquals((await pendingJoinAttempts(await store.server())).length, 1);
    await assertRejects(
      () => joinRemote(store, args),
      MatrixError,
      'cleanup is pending',
    );
    assertEquals(calls.sendJoin.length, 1);
    assertEquals(
      await (await store.server()).query('SELECT * FROM federation_invites'),
      [],
    );
    await store.close();
    store = await openStore(settings, {
      schemas: { room: roomSchema, server: serverSchema },
    });
    const server = await store.server();
    sender = startSender({ store, signer });
    const deps: InviteDeps = {
      store,
      server,
      signer,
      keys: fakeKeyResolver(fr.server, remote),
      self: 'test',
      wake: sender.wake,
    };
    const provider = joinCleanupProvider(deps, inviteIntentProvider(deps));
    sender.setIntentProvider(provider);
    const visible = await sender.reviewIntents();
    assertEquals(visible?.[0].intent.what, 'join-cleanup');
    for (const row of visible!) sender.wake(row.destination);
    const deadline = Date.now() + 10000;
    while (
      (await pendingJoinAttempts(server)).length && Date.now() < deadline
    ) await new Promise((r) => setTimeout(r, 20));
    assertEquals(membership, 'leave');
    assertEquals(leaveCalls, 2);
    assertEquals(v2Calls, 2);
    assertEquals(
      fake.requests.filter((r) => r.path.includes('/make_leave/')).length,
      1,
    );
    const sent = fake.requests.filter((r) =>
      r.path.includes('/v1/send_leave/')
    );
    assertEquals(sent[0].path, sent[1].path);
    assertEquals(sent[0].body, sent[1].body);
    assertEquals(await pendingJoinAttempts(server), []);
    await assertRejects(() => openRoom(store, fr.roomId), Deno.errors.NotFound);
  } finally {
    await sender?.stop();
    await fake.close();
    await store.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});
