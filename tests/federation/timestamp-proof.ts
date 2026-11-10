import { assert, assertEquals } from '@std/assert';
import { startInstance } from '#tests/federation/instance.ts';
import { startHttp } from '#tests/http-app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { joinRemote } from '#engine/room/join.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { keyStore, ourKeyDocument } from '#engine/federation/keys.ts';
import { directOnly } from '#tests/federation/doc-helper.ts';

// Two-server proof belongs in communico-5c/communico-interop on ark, not CT800.
Deno.test('timestamp: real signed remote lookup yields usable HTTP context and backward pagination without live news', async () => {
  const resident = await startInstance();
  const local = await startHttp();
  try {
    await resident.sender.stop();
    const alice = await local.registerTestUser('timestamp-local', 'pw');
    const owner = '@owner:' + resident.name;
    const { roomId } = await createRoom(resident.store, {
      creator: owner,
      version: '11',
      preset: 'public_chat',
    }, resident.signer);
    const remoteRoom = await openRoom(resident.store, roomId);
    const events: string[] = [];
    for (const ts of [100, 110, 120, 130]) {
      const event = await sendLocal(remoteRoom, {
        type: 'm.room.encrypted',
        sender: owner,
        origin_server_ts: ts,
        content: { algorithm: 'm.megolm.v1.aes-sha2', ciphertext: String(ts) },
      }, resident.signer);
      events.push(event.eventId);
    }
    const app = local.app, signer = app.tenant.signer();
    await keyStore(resident.server, {
      deps: directOnly(await ourKeyDocument(signer, app.tenant.publicB64)),
    }).acquireKeyDoc(signer.serverName, 0);
    const deps = {
      self: signer.serverName,
      keys: productionKeyResolver(app.server, signer),
      fetcher: productionFetcher(app.server, signer, app.store),
    };
    await joinRemote(app.store, {
      roomId,
      user: alice.user_id!,
      via: [resident.name],
      signer,
      deps,
    });
    const held = await openRoom(app.store, roomId);
    assertEquals(
      await held.tx((tx) => tx.segments.positionOf(events[2])),
      null,
    );
    const beforeFeed = await app.server.query('SELECT COUNT(*) AS n FROM feed');
    const query = async (path: string) => {
      const response = await local.matrix(
        new Request('http://x/_matrix/client/' + path, {
          headers: { authorization: 'Bearer ' + alice.access_token },
        }),
      );
      const body = await response.json();
      assertEquals(response.status, 200, JSON.stringify(body));
      return body;
    };
    const encoded = encodeURIComponent(roomId);
    const hit = await query(
      'v1/rooms/' + encoded + '/timestamp_to_event?ts=115&dir=f',
    );
    assertEquals(hit, { event_id: events[2], origin_server_ts: 120 });
    const emptyContext = await query(
      'v3/rooms/' + encoded + '/context/' + encodeURIComponent(hit.event_id) +
        '?limit=0',
    );
    const forward = await query(
      'v3/rooms/' + encoded + '/messages?dir=f&limit=1&from=' +
        encodeURIComponent(emptyContext.end),
    );
    assertEquals(forward.chunk[0]?.event_id, events[3]);
    assert(typeof forward.end === 'string');
    const continued = await query(
      'v3/rooms/' + encoded + '/messages?dir=f&limit=1&from=' +
        encodeURIComponent(forward.end),
    );
    assert(
      continued.chunk.length > 0,
      'forward pagination reaches the held joined stay',
    );
    const context = await query(
      'v3/rooms/' + encoded + '/context/' + encodeURIComponent(hit.event_id) +
        '?limit=2',
    );
    assertEquals(context.event.event_id, events[2]);
    assertEquals(context.events_before[0].event_id, events[1]);
    assertEquals(context.events_after[0]?.event_id, events[3]);
    assert(typeof context.start === 'string');
    const messages = await query(
      'v3/rooms/' + encoded + '/messages?dir=b&limit=2&from=' +
        encodeURIComponent(context.start),
    );
    assert(
      messages.chunk.some((e: Record<string, unknown>) =>
        e.event_id === events[0]
      ),
    );
    const backwards = await query(
      'v1/rooms/' + encoded + '/timestamp_to_event?ts=125&dir=b',
    );
    assertEquals(backwards, { event_id: events[2], origin_server_ts: 120 });
    assertEquals(
      await app.server.query('SELECT COUNT(*) AS n FROM feed'),
      beforeFeed,
    );
  } finally {
    await local.close();
    await resident.close();
  }
});
