// tests/concurrency.test.ts — band C §0: authorAndIngest holds the room
// lock across author+ingest, so 8 parallel /send ops on one room each
// author on the live tip: 8 distinct events, one extremity, all 200 (no
// M_PREV_NOT_EXTREMITY can race — the M4 retry loop is retired; the grep
// check in plan §6 pins the mechanism). Live doltgres, HTTP-level via the
// real endpoint trees.
import { assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { extremities, lookupRoom } from '#engine/room.ts';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

Deno.test('8 parallel /send on one room: 8 distinct events, one extremity, no stale-prev', async () => {
  const alice = await registerTestUser('conc-a', 'pw-conc-a');
  const tok = alice.access_token!;
  const created = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: tok,
    body: {},
  });
  assertEquals(created.status, 200);
  const roomId = created.body.room_id as string;

  const sends = Array.from({ length: 8 }, (_, i) =>
    call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(roomId)
      }/send/m.room.message/m-conc-${i}`,
      {
        method: 'PUT',
        token: tok,
        body: { msgtype: 'm.text', body: `burst ${i}` },
      },
    ));
  const results = await Promise.all(sends);

  for (const res of results) assertEquals(res.status, 200);
  const ids = new Set(results.map((r) => r.body.event_id as string));
  assertEquals(ids.size, 8);

  // all eight landed on one chain: exactly one extremity branch
  const room = await lookupRoom(roomId);
  const tips = await extremities(room!.dbName, roomId);
  assertEquals(tips.length, 1);
});
