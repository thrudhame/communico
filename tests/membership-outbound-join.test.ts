import { assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import type { Pdu } from '#engine/pdu.ts';
import { joinRemote } from '#engine/room/join.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import {
  installJoinAdmission,
  pendingJoinAttempts,
} from '#engine/server/join-attempts.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { fakeFetcher, fakeKeyResolver } from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';
import { admitLocalJoin } from '#engine/room/hooks.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import { inviteIntentProvider } from '#engine/federation/invites.ts';
import { joinCleanupProvider } from '#engine/federation/join-cleanup.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { toWire } from '#engine/federation/pdu.ts';

Deno.test('outbound join retains the exact signed attempt before network under either encryption policy', async (t) => {
  const old = config();
  try {
    for (const permissive of [true, false]) {
      await t.step(String(permissive), async () => {
        setConfigForTests({
          encryption: { allowunencryptedjoining: permissive },
        });
        const dir = await Deno.makeTempDir({ prefix: 'outbound-join-' });
        const settings = {
          dir,
          library: './.native/libturso_ffi.so',
          checkpointlogbytes: 65536,
          maxopenfiles: 8,
          idleseconds: 300,
        };
        const schemas = { room: roomSchema, server: serverSchema };
        let store = await openStore(settings, { schemas });
        try {
          const fr = await makeFakeRoom({ roomId: '!outbound:remote.test' });
          const signer = await testSigner();
          let observed: Pdu | undefined;
          let peerMember = 'leave';
          const { fetcher, calls } = fakeFetcher({
            makeJoin: (user) => fr.makeJoinAnswer(user),
            sendJoin: async (pdu) => {
              observed = structuredClone(pdu);
              const rows = await pendingJoinAttempts(await store.server());
              assertEquals(
                rows.length,
                1,
                'durable attempt precedes send_join',
              );
              assertEquals(
                rows[0].signed,
                pdu,
                'retained signed bytes are the actual network PDU',
              );
              await assertRejects(
                () => admitLocalJoin(store, fr.roomId, '@anna:test'),
                Error,
                'cleanup is pending',
              );
              await assertRejects(
                () => admitLocalJoin(store, fr.roomId, '@anna:test', '$other'),
                Error,
                'cleanup is pending',
              );
              await admitLocalJoin(
                store,
                fr.roomId,
                '@anna:test',
                String(pdu.event_id),
              );
              await fr.acceptSendJoin(pdu);
              peerMember = 'join';
              throw new Error(
                'response lost after remote membership committed',
              );
            },
          });
          await assertRejects(
            () =>
              joinRemote(store, {
                roomId: fr.roomId,
                user: '@anna:test',
                via: [fr.server.name],
                signer,
                deps: {
                  self: 'test',
                  fetcher,
                  keys: fakeKeyResolver(fr.server),
                },
              }),
            Error,
            'response lost',
          );
          assertEquals(peerMember, 'join');
          assertEquals(calls.sendJoin.length, 1);
          await assertRejects(
            () => openRoom(store, fr.roomId),
            Deno.errors.NotFound,
          );
          await store.close();
          store = await openStore(settings, { schemas });
          installJoinAdmission(store);
          const retained = await pendingJoinAttempts(await store.server());
          assertEquals(retained.length, 1);
          assertEquals(retained[0].signed, observed);
          assertEquals(retained[0].destination, fr.server.name);
          await assertRejects(
            () =>
              admitLocalJoin(
                store,
                fr.roomId,
                '@anna:test',
                String(observed!.event_id),
              ),
            Error,
            'cleanup is pending',
          );
          await assertRejects(
            () =>
              joinRemote(store, {
                roomId: fr.roomId,
                user: '@anna:test',
                via: [fr.server.name],
                signer,
                deps: {
                  self: 'test',
                  fetcher,
                  keys: fakeKeyResolver(fr.server),
                },
              }),
            Error,
            'cleanup is pending',
          );
          assertEquals(
            calls.sendJoin.length,
            1,
            'no replacement join while cleanup is owed',
          );
        } finally {
          await store.close();
          await Deno.remove(dir, { recursive: true });
        }
      });
    }
  } finally {
    setConfigForTests(old);
  }
});

Deno.test('outbound join schema upgrade preserves old compensation without inventing signed work', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'join-attempt-upgrade-' });
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(settings, {
    schemas: { server: historicalServerSchema(47) },
  });
  try {
    await (await store.server()).execute(
      "INSERT INTO federation_join_attempts(room_id,user_id,event_id,room_version,destination,added_ms,leave_json) VALUES('!r:peer','@a:test','$old','11','peer',123,'{\"event_id\":\"$leave\"}')",
    );
    await store.close();
    store = await openStore(settings, { schemas: { server: serverSchema } });
    assertEquals(await pendingJoinAttempts(await store.server()), [{
      roomId: '!r:peer',
      userId: '@a:test',
      eventId: '$old',
      roomVersion: '11',
      destination: 'peer',
      addedMs: 123,
      signed: null,
    }]);
    assertEquals(
      await (await store.server()).query(
        'SELECT leave_json FROM federation_join_attempts',
      ),
      [{ leave_json: '{"event_id":"$leave"}' }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('permissive outbound join lost response is compensated through exact signed HTTP leave across cold retries', async () => {
  const old = config();
  setConfigForTests({
    encryption: { allowunencryptedjoining: true },
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  const dir = await Deno.makeTempDir({ prefix: 'outbound-join-http-' });
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(settings, { schemas });
  const signer = await testSigner();
  const local = await testRemoteServer();
  let fr: Awaited<ReturnType<typeof makeFakeRoom>>;
  let membership = 'leave';
  let leaveCalls = 0;
  const peer = await startFakeServer({
    ourKeyDoc: async () => ({
      server_name: signer.serverName,
      verify_keys: {
        [signer.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(local.kp.publicKey)),
        },
      },
    }),
    handlers: (req) => {
      if (req.path === '/test-membership') return Response.json({ membership });
      if (req.path.includes('/make_join/')) {
        return Response.json({
          room_version: fr.version,
          event: fr.makeJoinAnswer('@anna:test').event,
        });
      }
      if (req.path.includes('/send_join/')) {
        return (async () => {
          assertEquals(req.verified, true);
          const attempts = await pendingJoinAttempts(await store.server());
          assertEquals(attempts.length, 1);
          assertEquals(req.json(), toWire(attempts[0].signed!, fr.version));
          const pdu = req.json() as Pdu;
          pdu.event_id = decodeURIComponent(
            req.url.pathname.split('/').at(-1)!,
          );
          await fr.acceptSendJoin(pdu);
          membership = 'join';
          return Response.json({}); // Committed remote join, unusable response.
        })();
      }
      if (req.path.includes('/make_leave/')) {
        return Response.json({
          room_version: fr.version,
          event: fr.makeLeaveAnswer('@anna:test').event,
        });
      }
      if (req.path.includes('/send_leave/')) {
        assertEquals(req.verified, true);
        assertEquals((req.json() as Pdu).content.membership, 'leave');
        membership = 'leave';
        return ++leaveCalls === 1
          ? Response.json({ errcode: 'M_UNKNOWN' }, { status: 503 })
          : Response.json({});
      }
      return null;
    },
  });
  const http = Deno.createHttpClient({
    caCerts: [await Deno.readTextFile('tests/fixtures/tls/ca.crt')],
  });
  const observe = async () => {
    const result = await fetch('https://' + peer.name + '/test-membership', {
      client: http,
    });
    assertEquals(result.status, 200);
    return (await result.json()).membership;
  };
  try {
    fr = await makeFakeRoom({
      roomId: '!outbound-http:' + peer.name,
      server: peer,
    });
    const storeServer = await store.server();
    await assertRejects(() =>
      joinRemote(store, {
        roomId: fr.roomId,
        user: '@anna:test',
        via: [peer.name],
        signer,
        deps: {
          self: 'test',
          fetcher: productionFetcher(storeServer, signer, store),
          keys: fakeKeyResolver(peer, local),
        },
      })
    );
    assertEquals(await observe(), 'join');
    const sent = (await pendingJoinAttempts(await store.server()))[0].signed;
    for (const first of [true, false]) {
      await store.close();
      store = await openStore(settings, { schemas });
      const server = await store.server();
      assertEquals((await pendingJoinAttempts(server))[0].signed, sent);
      const deps = {
        store,
        server,
        signer,
        self: 'test',
        keys: fakeKeyResolver(peer, local),
        wake: () => {},
      };
      const provider = joinCleanupProvider(deps, inviteIntentProvider(deps));
      const job = await provider(server, peer.name);
      assertEquals(job?.id, 'join-cleanup:' + sent!.event_id);
      if (first) await assertRejects(() => job!.run());
      else await job!.run();
      assertEquals(await observe(), 'leave');
      assertEquals((await pendingJoinAttempts(server)).length, first ? 1 : 0);
    }
    const leaves = peer.requests.filter((req) =>
      req.path.includes('/send_leave/')
    );
    assertEquals(leaves.length, 2);
    assertEquals(leaves[0].path, leaves[1].path);
    assertEquals(leaves[0].body, leaves[1].body);
    assertEquals(
      peer.requests.filter((req) => req.path.includes('/make_leave/')).length,
      1,
    );
    assertEquals(
      peer.requests.filter((req) => req.path.includes('/send_join/')).length,
      1,
    );
    await assertRejects(() => openRoom(store, fr.roomId), Deno.errors.NotFound);
  } finally {
    http.close();
    await peer.close();
    await store.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});
