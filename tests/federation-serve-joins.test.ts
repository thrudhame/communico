// tests/federation-serve-joins.test.ts — M5b commit 7: the resident
// role. make_join (template fields, the 400/403/404 matrix, `ver`);
// send_join v1/v2 (validation 400s, banned 403, our signature added,
// state/auth_chain/event/servers_in_room, outbox excludes the joiner);
// make/send_leave v1/v2. Live doltgres; the origin's document is seeded.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { serverName } from '#engine/config.ts';
import { createRoom, membershipOf } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { wireFederationTransport } from '#engine/federation/client.ts';
import { signJson } from '#engine/signing-primitives.js';
import { eventIdFor } from '#engine/eventid.ts';
import {
  latestExtremityEventId,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { makeRoomServer } from './federation/fake-room.ts';
import { seedServer } from './federation/doc-helper.ts';
import { remoteEvent } from './federation/room-events.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const ROOM = '!fed-joins:localhost';

type Json = Record<string, unknown>;
const srv = await makeRoomServer('remote.test');
const ZOE = '@zoe:remote.test';

async function fedCall(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Json | Json[] }> {
  const obj: Json = {
    method,
    uri: path,
    origin: srv.name,
    destination: serverName(),
  };
  if (body !== undefined) obj.content = body;
  const signed = await signJson(obj, srv.name, srv.keyId, srv.kp.privateKey);
  const sig =
    (signed.signatures as Record<string, Record<string, string>>)[srv.name][
      srv.keyId
    ];
  const res = await matrix(
    new Request(`http://x${path}`, {
      method,
      headers: {
        Authorization:
          `X-Matrix origin="${srv.name}",key="${srv.keyId}",sig="${sig}"`,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

async function setup(): Promise<void> {
  await resetFederationTables();
  await resetRoom(ROOM);
  await seedServer(srv);
  wireFederationTransport();
  await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
  });
}

function wireOf(pdu: Record<string, unknown>): Record<string, unknown> {
  const out = { ...pdu };
  delete out.event_id;
  delete out.unsigned;
  return out;
}

async function signedJoin(prevId: string): Promise<Record<string, unknown>> {
  const join = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.member',
    sender: ZOE,
    state_key: ZOE,
    content: { membership: 'join' },
    prev_events: [prevId],
  });
  return wireOf(join as unknown as Record<string, unknown>);
}

Deno.test('make_join: template fields; 400 ver; 403 domain; 404 room; 403 banned', async () => {
  await setup();
  const res = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(ZOE)
    }?ver=11`,
  );
  assertEquals(res.status, 200);
  const body = res.body as Json;
  assertEquals(body.room_version, '11'); // the spec's wrapper
  const t = body.event as Json;
  assertEquals(t.type, 'm.room.member');
  assertEquals(t.state_key, ZOE);
  assertEquals(t.sender, ZOE);
  assertEquals(t.room_id, ROOM);
  assertEquals((t.content as Json).membership, 'join');
  assertEquals(t.origin, serverName());
  assert(Array.isArray(t.prev_events));
  assert(Array.isArray(t.auth_events));
  assertEquals(typeof t.depth, 'number');
  assertEquals(typeof t.origin_server_ts, 'number');
  for (const absent of ['event_id', 'hashes', 'signatures', 'unsigned']) {
    assert(!(absent in t), `template has no ${absent}`);
  }
  // ver mismatch → 400 M_INCOMPATIBLE_ROOM_VERSION + room_version
  const badVer = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(ZOE)
    }?ver=3`,
  );
  assertEquals(badVer.status, 400);
  assertEquals((badVer.body as Json).errcode, 'M_INCOMPATIBLE_ROOM_VERSION');
  assertEquals((badVer.body as Json).room_version, '11');
  // a user not on the origin → 403
  const wrongDomain = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent('@zoe:other.test')
    }`,
  );
  assertEquals(wrongDomain.status, 403);
  // unknown room → 404
  const unknown = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_join/${
      encodeURIComponent('!nope:localhost')
    }/${encodeURIComponent(ZOE)}`,
  );
  assertEquals(unknown.status, 404);
  // banned → 403
  const ban = await author(ROOM, {
    type: 'm.room.member',
    state_key: ZOE,
    sender: '@dev:localhost',
    content: { membership: 'ban' },
  });
  await ingestEvent(ROOM, ban);
  const banned = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(ZOE)
    }?ver=11`,
  );
  assertEquals(banned.status, 403);
});

Deno.test('send_join v2: validation, our signature added, the snapshot, outbox excludes the joiner', async () => {
  await setup();
  const tip = await latestExtremityEventId(ROOM);
  const join = await signedJoin(tip);
  const eventId = await eventIdFor(join, '11');
  // validation: wrong type → 400
  const wrongType = { ...join, type: 'm.room.message' };
  const r1 = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(eventId)
    }`,
    wrongType,
  );
  assertEquals(r1.status, 400);
  // state_key ≠ sender → 400
  const wrongKey = { ...join, state_key: '@someone:remote.test' };
  const r2 = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(eventId)
    }`,
    wrongKey,
  );
  assertEquals(r2.status, 400);
  // room_id mismatch → 400
  const wrongRoom = { ...join, room_id: '!elsewhere:remote.test' };
  const r3 = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(eventId)
    }`,
    wrongRoom,
  );
  assertEquals(r3.status, 400);
  // bad path id → 400
  const r4 = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/$not-the-id`,
    join,
  );
  assertEquals(r4.status, 400);
  // bad signature → 403
  const badSig = JSON.parse(JSON.stringify(join)) as Json;
  (badSig.signatures as Json)['remote.test'] = { 'ed25519:1': 'AAAA' };
  const r5 = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(eventId)
    }`,
    badSig,
  );
  assertEquals(r5.status, 403);
  // the good join
  const res = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(eventId)
    }`,
    join,
  );
  assertEquals(res.status, 200);
  const body = res.body as Json;
  assert(Array.isArray(body.state));
  assert(Array.isArray(body.auth_chain));
  assertEquals(body.members_omitted, false);
  assertEquals(body.servers_in_room, [serverName()]);
  // our signature rides the returned event next to the origin's
  const event = body.event as Json;
  const sigs = event.signatures as Record<string, unknown>;
  assert(sigs[srv.name] !== undefined, 'origin signature kept');
  assert(sigs[serverName()] !== undefined, 'our signature added');
  assert(!('event_id' in event), 'wire form');
  // the join landed
  const m = await membershipOf(ROOM, ZOE);
  assertEquals(m?.membership, 'join');
  // outbox rows for the join exclude the origin — none at all here (the
  // joiner's server IS the only remote member)
  const rows = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT destination FROM federation_outbox WHERE event_id = $1;',
      [eventId],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows.map((x: any) => String(x.destination));
  });
  assertEquals(rows, []);
});

Deno.test('send_join v1 answers [200, {...}]; send_leave v1/v2; make_leave 403 for a non-member', async () => {
  await setup();
  const tip = await latestExtremityEventId(ROOM);
  const join = await signedJoin(tip);
  const { eventIdFor } = await import('#engine/eventid.ts');
  const joinId = await eventIdFor(join, '11');
  const res = await fedCall(
    'PUT',
    `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(joinId)
    }`,
    join,
  );
  assertEquals(res.status, 200);
  const arr = res.body as unknown[];
  assertEquals(arr[0], 200);
  assert((arr[1] as Json).state !== undefined);
  assert((arr[1] as Json).auth_chain !== undefined);
  assert((arr[1] as Json).event !== undefined);

  // make_leave for a non-member → 403
  const notHere = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${
      encodeURIComponent('@nobody:remote.test')
    }?ver=11`,
  );
  assertEquals(notHere.status, 403);

  // make_leave for the member → the template; send_leave v2 → {}
  const ml = await fedCall(
    'GET',
    `/_matrix/federation/v1/make_leave/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(ZOE)
    }?ver=11`,
  );
  assertEquals(ml.status, 200);
  const mlBody = ml.body as Json;
  assertEquals(mlBody.room_version, '11'); // the spec's wrapper
  const mlEvent = mlBody.event as Json;
  assertEquals(mlEvent.content !== undefined, true);
  assertEquals((mlEvent.content as Json).membership, 'leave');

  const leave = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.member',
    sender: ZOE,
    state_key: ZOE,
    content: { membership: 'leave' },
    prev_events: [await latestExtremityEventId(ROOM)],
  });
  const leaveWire = wireOf(leave as unknown as Record<string, unknown>);
  const leaveId = await eventIdFor(leaveWire, '11');
  const sl2 = await fedCall(
    'PUT',
    `/_matrix/federation/v2/send_leave/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(leaveId)
    }`,
    leaveWire,
  );
  assertEquals(sl2.status, 200);
  assertEquals(sl2.body, {});
  assertEquals((await membershipOf(ROOM, ZOE))?.membership, 'leave');

  // send_leave v1 → [200, {}]
  await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
  }).catch(() => {}); // already exists is fine for the v1 shape check
  const join2 = await signedJoin(await latestExtremityEventId(ROOM));
  const join2Id = await eventIdFor(join2, '11');
  await fedCall(
    'PUT',
    `/_matrix/federation/v1/send_join/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(join2Id)
    }`,
    join2,
  );
  const leave2 = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.member',
    sender: ZOE,
    state_key: ZOE,
    content: { membership: 'leave' },
    prev_events: [await latestExtremityEventId(ROOM)],
  });
  const leave2Wire = wireOf(leave2 as unknown as Record<string, unknown>);
  const leave2Id = await eventIdFor(leave2Wire, '11');
  const sl1 = await fedCall(
    'PUT',
    `/_matrix/federation/v1/send_leave/${encodeURIComponent(ROOM)}/${
      encodeURIComponent(leave2Id)
    }`,
    leave2Wire,
  );
  assertEquals(sl1.status, 200);
  assertEquals(sl1.body as unknown[], [200, {}]);
});
