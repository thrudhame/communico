// tests/federation-send.test.ts — M5b commit 4: inbound transactions.
// /send: origin mismatch 403; >50 PDUs 400; per-PDU results (accepted,
// unknown room, dropped, rejected {}); the replay cache; in-order
// processing; EDUs typing/receipt/presence for the origin's users (a
// wrong-domain user is ignored; an unknown type is ignored); the
// middleware's notifyPeerAlive reset; unknown prev → stored 'ungrounded'
// (the terminal rule) and the ungroundedmillihours = 0 drop. Live
// doltgres; the origin is a fake room server whose document is seeded.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverDb, withDb } from '#engine/db.ts';
import { serverName, setConfigForTests } from '#engine/config.ts';
import { createRoom, groundingOf } from '#engine/room.ts';
import { typingIn } from '#engine/typing.ts';
import { getPresence } from '#engine/presence.ts';
import { peerStatus } from '#engine/federation/outbox.ts';
import { wireFederationTransport } from '#engine/federation/client.ts';
import { signJson } from '#engine/signing-primitives.js';
import {
  latestExtremityEventId,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { makeRoomServer } from './federation/fake-room.ts';
import { seedServer } from './federation/doc-helper.ts';
import { remoteEvent, remoteJoin } from './federation/room-events.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const ROOM = '!fed-send:localhost';
const ROOM_OTHER = '!fed-send-other:localhost';
const DEV_TOKEN = 'devtoken'; // seeded by db-init

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

async function sendTxn(
  origin: string,
  txnId: string,
  body: Json,
): Promise<{ status: number; body: Json }> {
  const target = `/_matrix/federation/v1/send/${encodeURIComponent(txnId)}`;
  const obj: Json = {
    method: 'PUT',
    uri: target,
    origin,
    destination: serverName(),
    content: body,
  };
  const signed = await signJson(obj, origin, 'ed25519:1', srv.kp.privateKey);
  const sig =
    (signed.signatures as Record<string, Record<string, string>>)[origin][
      'ed25519:1'
    ];
  const res = await matrix(
    new Request(`http://x${target}`, {
      method: 'PUT',
      headers: {
        Authorization:
          `X-Matrix origin="${origin}",key="ed25519:1",sig="${sig}"`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

const srv = await makeRoomServer('remote.test');
let tip = '';

async function setup(): Promise<void> {
  await resetFederationTables();
  await resetRoom(ROOM);
  wireFederationTransport();
  await seedServer(srv);
  await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
  });
  tip = await latestExtremityEventId(ROOM);
  tip = await remoteJoin(ROOM, srv, '11', '@rudy:remote.test', tip);
}

Deno.test('send: origin mismatch 403, >50 PDUs 400, replay returns the stored answer', async () => {
  await setup();
  // origin mismatch
  const bad = await sendTxn('remote.test', 't-origin', {
    origin: 'other.test',
    origin_server_ts: Date.now(),
    pdus: [],
    edus: [],
  });
  assertEquals(bad.status, 403);
  assertEquals(bad.body.errcode, 'M_FORBIDDEN');
  // >50 PDUs
  const many = [];
  for (let i = 0; i < 51; i++) many.push({ type: 'm.room.message' });
  const tooBig = await sendTxn('remote.test', 't-many', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: many,
  });
  assertEquals(tooBig.status, 400);
  assertEquals(tooBig.body.errcode, 'M_TOO_LARGE');
  // replay: a valid transaction, then the same id again with a DIFFERENT
  // body — the stored answer comes back
  const event = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'replay me' },
    prev_events: [tip],
  });
  const first = await sendTxn('remote.test', 't-replay', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [event],
  });
  assertEquals(first.status, 200);
  assertEquals(first.body.pdus, { [String(event.event_id)]: {} });
  const second = await sendTxn('remote.test', 't-replay', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [],
  });
  assertEquals(second.status, 200);
  assertEquals(second.body, first.body);
});

Deno.test('send: per-PDU outcomes — accepted {}, unknown room, dropped error, rejected {}', async () => {
  await setup();
  const good = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'good' },
    prev_events: [tip],
  });
  const unknownRoom = await remoteEvent(ROOM_OTHER, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'nowhere' },
    prev_events: ['$madeup'],
    auth_events: ['$madeupcreate'],
  });
  const badSig = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'forged sig' },
    prev_events: [tip],
  });
  (badSig.signatures as Record<string, Record<string, string>>)[
    'remote.test'
  ]['ed25519:1'] = 'AAAA';
  const nonMember = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@stranger:remote.test', // never joined — rule 5 rejects
    content: { msgtype: 'm.text', body: 'not a member' },
    prev_events: [tip],
  });
  const res = await sendTxn('remote.test', 't-outcomes', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [good, unknownRoom, badSig, nonMember],
  });
  assertEquals(res.status, 200);
  const pdus = res.body.pdus as Record<string, Json>;
  assertEquals(pdus[String(good.event_id)], {});
  const unknown = pdus[String(unknownRoom.event_id)];
  assert(String(unknown?.error).includes('unknown room'), JSON.stringify(pdus));
  const dropped = pdus[String(badSig.event_id)];
  assert(dropped?.error !== undefined, 'dropped carries an error');
  assertEquals(
    pdus[String(nonMember.event_id)],
    {},
    'rejection is not an error',
  );
  // the accepted one is really in the room now
  const msgs = await call(
    `/_matrix/client/v3/rooms/${
      encodeURIComponent(ROOM)
    }/messages?dir=b&limit=5`,
    { token: DEV_TOKEN },
  );
  const bodies = (msgs.body.chunk as Json[]).map((e) =>
    (e.content as Json | undefined)?.body
  );
  assert(bodies.includes('good'), JSON.stringify(bodies));
});

Deno.test('send: in-order processing of a fork', async () => {
  await setup();
  const e1 = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'fork e1' },
    prev_events: [tip],
  });
  const e2 = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'fork e2' },
    prev_events: [String(e1.event_id)],
  });
  const res = await sendTxn('remote.test', 't-fork', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [e1, e2],
  });
  assertEquals(res.status, 200);
  assertEquals(res.body.pdus, {
    [String(e1.event_id)]: {},
    [String(e2.event_id)]: {},
  });
});

Deno.test('send: EDUs — typing, receipt, presence for the origin’s users; wrong domain ignored; unknown type ignored', async () => {
  await setup();
  const event = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'receipt target' },
    prev_events: [tip],
  });
  const res = await sendTxn('remote.test', 't-edus', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [event],
    edus: [
      {
        edu_type: 'm.typing',
        content: { room_id: ROOM, user_id: '@rudy:remote.test', typing: true },
      },
      // wrong domain — ignored
      {
        edu_type: 'm.typing',
        content: { room_id: ROOM, user_id: '@nope:other.test', typing: true },
      },
      {
        edu_type: 'm.receipt',
        content: {
          [ROOM]: {
            'm.read': {
              '@rudy:remote.test': {
                event_ids: [String(event.event_id)],
                data: { ts: 1234567890 },
              },
            },
          },
        },
      },
      {
        edu_type: 'm.presence',
        content: {
          push: [{
            user_id: '@rudy:remote.test',
            presence: 'online',
            status_msg: 'on the wire',
            last_active_ago: 1000,
            currently_active: true,
          }],
        },
      },
      {
        edu_type: 'm.device_list_update',
        content: { user_id: '@rudy:remote.test' },
      },
      { edu_type: 'm.something.unknown', content: {} },
    ],
  });
  assertEquals(res.status, 200);
  // typing lands for the origin's user only
  const typing = typingIn(ROOM);
  assert(typing.userIds.includes('@rudy:remote.test'), JSON.stringify(typing));
  assert(!typing.userIds.some((u) => u.endsWith(':other.test')));
  // the receipt renders in the room's sync
  const sync = await call(
    `/_matrix/client/v3/sync?timeout=0&filter=${
      encodeURIComponent(JSON.stringify({ room: { timeline: { limit: 5 } } }))
    }`,
    { token: DEV_TOKEN },
  );
  const roomSection = ((sync.body.rooms as Json).join as Json)[ROOM] as Json;
  const ephemeral = ((roomSection.ephemeral as Json | undefined)?.events as
    | Json[]
    | undefined) ?? [];
  const receiptEv = ephemeral.find((e) => (e as Json).type === 'm.receipt') as
    | Json
    | undefined;
  assert(receiptEv !== undefined, JSON.stringify(ephemeral));
  // presence row
  const presence = await getPresence('@rudy:remote.test');
  assertEquals(presence.presence, 'online');
  assertEquals(presence.statusMsg, 'on the wire');
});

Deno.test('send: the middleware resets the delivery backoff (notifyPeerAlive)', async () => {
  await setup();
  // a backed-off destination
  await withDb(serverDb(), async (c) => {
    await c.query(
      `INSERT INTO federation_peer_status (destination, failures, attempts_total, failures_total, unreachable_since_ms, next_attempt_ms)
       VALUES ('remote.test', 5, 9, 5, $1, $2);`,
      [Date.now() - 60_000, Date.now() + 3_600_000],
    );
  });
  const res = await sendTxn('remote.test', 't-alive', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [],
  });
  assertEquals(res.status, 200);
  const st = await peerStatus('remote.test');
  assertEquals(st.failures, 0);
  assertEquals(st.nextAttemptMs, 0);
  assert(st.lastInboundMs !== null);
});

Deno.test('send: unknown prev → stored ungrounded (terminal); ungroundedmillihours = 0 drops', async () => {
  await setup();
  const orphaned = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'no parents' },
    prev_events: ['$madeupprev1', '$madeupprev2'],
  });
  const res = await sendTxn('remote.test', 't-ungrounded', {
    origin: 'remote.test',
    origin_server_ts: Date.now(),
    pdus: [orphaned],
  });
  assertEquals(res.status, 200);
  assertEquals(res.body.pdus, { [String(orphaned.event_id)]: {} });
  // the placeholder: rejected 'ungrounded', expires set, waiting rows
  const row = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT rejected, rejected_reason, expires_ms, origin, seq FROM event_index WHERE event_id = $1;',
      [String(orphaned.event_id)],
    );
    return r.rows.length ? r.rows[0] : null;
  });
  assert(row !== null, 'placeholder row exists');
  assertEquals(row.rejected, true);
  assertEquals(String(row.rejected_reason), 'ungrounded');
  assert(row.expires_ms !== null, 'expires_ms set');
  assertEquals(row.seq, null, 'a placeholder is never news');
  assertEquals(
    await groundingOf(ROOM, String(orphaned.event_id)),
    'placeholder',
  );
  const waiting = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT missing_prev FROM event_index_waiting WHERE event_id = $1 ORDER BY missing_prev;',
      [String(orphaned.event_id)],
    );
    // deno-lint-ignore no-explicit-any
    return r.rows.map((x: any) => String(x.missing_prev));
  });
  assertEquals(waiting, ['$madeupprev1', '$madeupprev2']);
  // ungroundedmillihours = 0 → dropped with an { error }
  setConfigForTests({ federation: { ungroundedmillihours: 0 } });
  try {
    const other = await remoteEvent(ROOM, srv, '11', {
      type: 'm.room.message',
      sender: '@rudy:remote.test',
      content: { msgtype: 'm.text', body: 'also no parents' },
      prev_events: ['$alsomadeup'],
    });
    const res2 = await sendTxn('remote.test', 't-dropped', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [other],
    });
    assertEquals(res2.status, 200);
    const pdus = res2.body.pdus as Record<string, Json>;
    assert(
      pdus[String(other.event_id)]?.error !== undefined,
      JSON.stringify(pdus),
    );
    const gone = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT 1 FROM event_index WHERE event_id = $1;',
        [String(other.event_id)],
      );
      return r.rows.length;
    });
    assertEquals(gone, 0, 'dropped, not stored');
  } finally {
    setConfigForTests({ federation: { ungroundedmillihours: 256000 } });
  }
});
