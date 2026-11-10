import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP bounded sync timeline');
type Json = Record<string, unknown>;
suite.test('a small page does not hydrate or render the room history', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('bounded-sync', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: user.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  let last = '';
  for (let n = 0; n < 40; n++) {
    last = (await sendLocal(room, {
      type: 'm.room.message',
      sender: user.user_id,
      content: { body: String(n) },
    }, signer)).eventId;
  }
  const original = app.server.query.bind(app.server);
  let cuts = 0;
  const pageLimits: number[] = [];
  app.server.query = async (sql, params) => {
    if (sql.includes('SELECT pos, stay FROM feed')) cuts++;
    if (sql.includes('SELECT seq, room, pos, event, stay FROM feed')) {
      pageLimits.push(Number(params?.at(-1)));
    }
    return await original(sql, params);
  };
  let body: Json;
  try {
    const filter = encodeURIComponent('{"room":{"timeline":{"limit":1}}}');
    const response = await suite.matrix(
      new Request('http://x/_matrix/client/v3/sync?filter=' + filter, {
        headers: { Authorization: 'Bearer ' + user.access_token },
      }),
    );
    assertEquals(response.status, 200);
    body = await response.json();
  } finally {
    app.server.query = original;
  }
  const entry = ((body.rooms as Json).join as Json)[roomId] as Json;
  assertEquals(
    ((entry.timeline as Json).events as Json[]).map((e) => e.event_id),
    [last],
  );
  assert(
    pageLimits.length > 0 && pageLimits.every((n) => n <= 32),
    String(pageLimits),
  );
  assert(
    cuts <= 4,
    'only the requested page plus one lookahead is rendered: ' + cuts,
  );
});
