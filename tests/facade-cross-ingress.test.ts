import { assert, assertEquals } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { makeJoin, sendJoin } from '#engine/federation/joins.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { startSender } from '#engine/federation/sender.ts';
import type { Pdu } from '#engine/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { exportReplicaRoom } from '#engine/room/replica-export.ts';
import { importReplicaRoom } from '#engine/room/replica-import.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { remoteEvent } from './fixtures/remote.ts';
import { bounded } from './helpers/server-process.ts';
import { startHttp } from './http-app.ts';

Deno.test('home sync observes a facade remote join before its invite reaches the joined peer', async () => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const http = await startHttp();
  const { store: home, tenant } = http.app;
  const signer = tenant.signer();
  const dir = await Deno.makeTempDir({ prefix: 'facade-observation-' });
  const edge = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema, server: serverSchema } });
  const delivered = Promise.withResolvers<Pdu>();
  let inviteId = '';
  const peer = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: tenant.serverName,
        verify_keys: { [tenant.keyId]: { key: tenant.publicB64 } },
      }),
    handlers: (request) => {
      if (!request.path.includes('/send/')) return null;
      return (async () => {
        assert(request.verified);
        const { pdus } = request.json() as { pdus: Pdu[] };
        for (const event of pdus) {
          if (
            await eventIdFor(event as unknown as Record<string, unknown>) ===
              inviteId
          ) {
            delivered.resolve(event);
          }
        }
        return Response.json({ pdus: {} });
      })();
    },
  });
  let sender: ReturnType<typeof startSender> | undefined;
  try {
    const alice = await http.registerTestUser('observe-alice', 'test-password');
    const bob = await http.registerTestUser('observe-bob', 'test-password');
    const { roomId } = await createRoom(home, {
      creator: alice.user_id,
      preset: 'public_chat',
    }, signer);
    const room = await openRoom(home, roomId);
    const keys = productionKeyResolver(http.app.federationKeys);
    const input = { self: tenant.serverName, keys, signatureUnion: true };
    await importReplicaRoom(
      edge,
      await exportReplicaRoom(room, tenant.serverName),
      input,
    );
    const replica = await openRoom(edge, roomId);
    const deps = {
      store: edge,
      server: await edge.server(),
      signer,
      keys,
      self: tenant.serverName,
      wake() {},
    };
    const user = '@peer:' + peer.name;
    const template = await makeJoin(roomId, user, peer.name, ['11'], deps);
    const join = await remoteEvent(roomId, peer, '11', template.event);
    await sendJoin(roomId, String(join.event_id), join, peer.name, 'v2', deps);
    const sync = async () => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/sync?timeout=0', {
          headers: { Authorization: 'Bearer ' + alice.access_token },
        }),
      );
      assertEquals(response.status, 200);
      return await response.json();
    };
    const events = (body: Awaited<ReturnType<typeof sync>>) =>
      [
        ...body.rooms.join[roomId].state.events,
        ...body.rooms.join[roomId].timeline.events,
      ] as Pdu[];
    // The facade ACK alone does not imply a home observation.
    assert(
      !events(await sync()).some((event) => event.event_id === join.event_id),
    );
    await importReplicaRoom(
      home,
      await exportReplicaRoom(replica, tenant.serverName),
      input,
    );
    assert(
      events(await sync()).some((event) =>
        event.event_id === join.event_id && event.state_key === user &&
        event.content.membership === 'join'
      ),
    );
    // Only now does the home client issue its causally dependent invitation.
    const response = await http.matrix(
      new Request(
        'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) +
          '/invite',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + alice.access_token,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ user_id: bob.user_id }),
        },
      ),
    );
    assertEquals(response.status, 200, await response.text());
    inviteId = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      assert(stay);
      const current = await tx.state.current(stay.id);
      assert(current !== null);
      return (await tx.state.groupKey(current, 'm.room.member', bob.user_id))!;
    });
    sender = startSender({ store: home, signer });
    const received = await bounded(delivered.promise);
    assertEquals(received.type, 'm.room.member');
    assertEquals(received.state_key, bob.user_id);
    assertEquals(received.content.membership, 'invite');
  } finally {
    await sender?.stop();
    await peer.close();
    await edge.close();
    await http.close();
    await Deno.remove(dir, { recursive: true });
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});
