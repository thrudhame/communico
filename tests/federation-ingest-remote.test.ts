// tests/federation-ingest-remote.test.ts — M5b commit 2: remote events
// through the ingest pipeline. Commit-hash branching (a consumed prev
// still grounds), relaxed depth/auth-set for remote (strict for local),
// the sender-domain signature through getVerifyKey with the room's
// witnesses, enforceKeyValidity, unsigned stripped, byte-vs-codepoint
// size limits + 'oversized', hash-mismatch → redacted copy stored,
// positions 'after'/'evidence' with the derived-table skip, and the
// witness ordering (roster first, then the room's servers by seniority).
// Live doltgres; no network — keys are seeded documents.
import { assert, assertEquals, assertRejects } from '@std/assert';
import { serverDb, withDb } from '#engine/db.ts';
import { serverName } from '#engine/config.ts';
import { createRoom, groundingOf } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { signPdu } from '#engine/signing.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { type KeysDeps, setKeysDeps } from '#engine/federation/keys.ts';
import { wireFederationTransport } from '#engine/federation/client.ts';
import { listWitnesses } from '#engine/federation/peers.ts';
import {
  latestExtremityEventId,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { makeRoomServer } from './federation/fake-room.ts';
import {
  createIdOf,
  remoteEvent,
  remoteJoin,
  storedCanonicalOf,
} from './federation/room-events.ts';
import { makeDoc, seedServer } from './federation/doc-helper.ts';

const ROOM = '!fed-ingest:localhost';
const ROOM4 = '!fed-ingest-v4:localhost';
const ROOM10 = '!fed-ingest-v10:localhost';

function stubDeps(over: Partial<KeysDeps> = {}): KeysDeps {
  return {
    directGet: over.directGet ??
      (() => Promise.reject(new Error('no direct in test'))),
    witnessQuery: over.witnessQuery ??
      (() => Promise.reject(new Error('no witnesses in test'))),
    listWitnesses: over.listWitnesses ?? (() => Promise.resolve([])),
  };
}

async function indexRow(roomId: string, eventId: string) {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT seq, era, branch_name, rejected, rejected_reason, origin, state_commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    return r.rows.length ? r.rows[0] : null;
  });
}

Deno.test('ingest remote: commit-hash branching, relaxed depth/auth-set, sender-domain signatures, key validity', async () => {
  await resetFederationTables();
  const srv = await makeRoomServer('remote.test');
  await seedServer(srv);
  setKeysDeps(stubDeps());
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
  });
  const tip1 = await latestExtremityEventId(ROOM);
  // the remote sender joins FIRST (public room) — rule 5 needs membership
  // in the state BEFORE each of their events
  const joinId = await remoteJoin(ROOM, srv, '11', '@rudy:remote.test', tip1);
  // e2 (local, consumes the join's branch)
  const e2 = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { msgtype: 'm.text', body: 'e2' },
    prev_events: [joinId],
    origin_server_ts: 1000,
  });
  await ingestEvent(ROOM, e2);
  const e2Id = String(e2.event_id);
  const createId = await createIdOf(ROOM);

  // 1. an event citing a CONSUMED prev is accepted (branch from the hash)
  const r1 = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'remote on consumed prev' },
    prev_events: [joinId],
  });
  const res1 = await ingestEvent(ROOM, r1, {
    remote: { origin: 'remote.test', position: 'after' },
  });
  assertEquals(res1.event_id, String(r1.event_id));
  // 2. a fork from the SAME old commit is accepted too
  const r2 = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'remote fork' },
    prev_events: [joinId],
  });
  await ingestEvent(ROOM, r2, {
    remote: { origin: 'remote.test', position: 'after' },
  });
  // 3. relaxed depth + auth-set for remote: depth far off, auth set only
  //    [create] (the rule-2.4 minimum — the rulebook would select more)
  //    — accepted; the same event from a LOCAL sender is an
  //    'auth' rejection (today's strictness)
  const r3 = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'relaxed' },
    prev_events: [e2Id],
    depth: 424242,
    auth_events: [createId!],
  });
  await ingestEvent(ROOM, r3, {
    remote: { origin: 'remote.test', position: 'after' },
  });
  const localBad = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { msgtype: 'm.text', body: 'wrong depth' },
    prev_events: [e2Id],
    origin_server_ts: 1001,
  });
  localBad.depth = Number(localBad.depth) + 5;
  const tenant = await getTenantKey();
  await signPdu(localBad, '11', tenant);
  const err = await assertRejects(() => ingestEvent(ROOM, localBad));
  assert(String(err).includes('M_AUTHCHAIN_REJECT'), String(err));

  // 4. sender-domain rule: signed by the sender's server -> accepted;
  //    signed by ANOTHER server than the sender's domain -> dropped
  const other = await makeRoomServer('other.test');
  await seedServer(other);
  const forged = await remoteEvent(ROOM, other, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test', // sender on remote.test, signed other.test
    content: { msgtype: 'm.text', body: 'wrong signer' },
    prev_events: [e2Id],
  });
  const err2 = await assertRejects(() =>
    ingestEvent(ROOM, forged, {
      remote: { origin: 'other.test', position: 'after' },
    })
  );
  assert(String(err2).includes('M_UNAUTHORIZED'), String(err2));
  // unknown server entirely (no document anywhere) -> dropped
  const stranger = await makeRoomServer('stranger.test');
  const noKey = await remoteEvent(ROOM, stranger, '11', {
    type: 'm.room.message',
    sender: '@x:stranger.test',
    content: { msgtype: 'm.text', body: 'no key' },
    prev_events: [e2Id],
  });
  const err3 = await assertRejects(() =>
    ingestEvent(ROOM, noKey, {
      remote: { origin: 'stranger.test', position: 'after' },
    })
  );
  assert(String(err3).includes('M_UNAUTHORIZED'), String(err3));

  // 5. enforceKeyValidity: a document valid only BEFORE the event's
  //    origin_server_ts fails for v5+ …
  const stale = await makeRoomServer('stale.test');
  const staleDoc = await makeDoc(stale, { validUntilMs: 500 });
  await seedServer(stale, staleDoc);
  setKeysDeps(
    stubDeps({ directGet: () => Promise.resolve(staleDoc) }),
  );
  const oldEvent = await remoteEvent(ROOM, stale, '11', {
    type: 'm.room.message',
    sender: '@old:stale.test',
    content: { msgtype: 'm.text', body: 'expired key' },
    prev_events: [e2Id],
    origin_server_ts: 1000,
  });
  const err4 = await assertRejects(() =>
    ingestEvent(ROOM, oldEvent, {
      remote: { origin: 'stale.test', position: 'after' },
    })
  );
  assert(String(err4).includes('M_UNAUTHORIZED'), String(err4));
  // … and passes for v4 (no validity rule)
  await resetRoom(ROOM4);
  await createRoom(ROOM4, '@dev:localhost', {
    roomVersion: '4',
    preset: 'public_chat',
  });
  const tip4 = await latestExtremityEventId(ROOM4);
  const join4 = await remoteJoin(ROOM4, stale, '4', '@old:stale.test', tip4);
  const create4 = await createIdOf(ROOM4);
  const old4 = await remoteEvent(ROOM4, stale, '4', {
    auth_events: [create4],
    type: 'm.room.message',
    sender: '@old:stale.test',
    content: { msgtype: 'm.text', body: 'v4 lenient' },
    prev_events: [join4],
    origin_server_ts: 1000,
  });
  await ingestEvent(ROOM4, old4, {
    remote: { origin: 'stale.test', position: 'after' },
  });

  // 6. unsigned stripped
  const withUnsigned = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'unsigned' },
    prev_events: [e2Id],
  });
  (withUnsigned as unknown as Record<string, unknown>).unsigned = {
    evil: true,
  };
  const resU = await ingestEvent(ROOM, withUnsigned, {
    remote: { origin: 'remote.test', position: 'after' },
  });
  const stored = await storedCanonicalOf(ROOM, resU.event_id);
  assert(
    !('unsigned' in (JSON.parse(stored) as Record<string, unknown>)),
    stored,
  );

  // 7. hash mismatch -> the REDACTED copy is stored (SS:1328-1336)
  const tampered = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'original' },
    prev_events: [e2Id],
  });
  (tampered.content as Record<string, unknown>).body = 'tampered';
  const resT = await ingestEvent(ROOM, tampered, {
    remote: { origin: 'remote.test', position: 'after' },
  });
  const storedT = await storedCanonicalOf(ROOM, resT.event_id);
  assert(!storedT.includes('tampered'), storedT);
  assert(!storedT.includes('original'), storedT);

  // 8. positions: 'after' lands in the stream with derived tables;
  //    'evidence' is seq NULL, branchless, unindexed
  const rel = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: {
      msgtype: 'm.text',
      body: 'positioned',
      'm.relates_to': { event_id: e2Id, rel_type: 'm.annotation' },
    },
    prev_events: [e2Id],
  });
  const resA = await ingestEvent(ROOM, rel, {
    remote: { origin: 'remote.test', position: 'after' },
  });
  const rowA = (await indexRow(ROOM, resA.event_id))!;
  assert(rowA.seq !== null && Number(rowA.seq) > 0, JSON.stringify(rowA));
  assertEquals(String(rowA.era), 'chapter1');
  assertEquals(String(rowA.origin), 'remote.test');
  const relRows = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT count(*) AS n FROM relations WHERE event_id = $1;',
      [resA.event_id],
    );
    return Number(r.rows[0].n);
  });
  assertEquals(relRows, 1);
  const ev = await remoteEvent(ROOM, srv, '11', {
    type: 'm.room.message',
    sender: '@rudy:remote.test',
    content: { msgtype: 'm.text', body: 'evidence' },
    prev_events: [e2Id],
  });
  const resE = await ingestEvent(ROOM, ev, {
    remote: { origin: 'remote.test', position: 'evidence' },
  });
  const rowE = (await indexRow(ROOM, resE.event_id))!;
  assertEquals(rowE.seq, null);
  assertEquals(rowE.branch_name, null);
  assertEquals(await groundingOf(ROOM, resE.event_id), 'evidence');
  const evRows = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT count(*) AS n FROM search_index WHERE event_id = $1;',
      [resE.event_id],
    );
    return Number(r.rows[0].n);
  });
  assertEquals(evRows, 0);

  wireFederationTransport();
});

Deno.test('ingest remote: size limits — bytes (v11+) vs codepoints (≤ v10), oversized stored', async () => {
  await resetFederationTables();
  const srv = await makeRoomServer('size.test');
  await seedServer(srv);
  setKeysDeps(stubDeps());
  // strict version: a 280-BYTE state_key is dropped
  await resetRoom(ROOM);
  await createRoom(ROOM, '@dev:localhost', { roomVersion: '11' });
  const tip = await latestExtremityEventId(ROOM);
  const bigKey = '💥'.repeat(70); // 280 bytes, 70 codepoints
  const dropped = await remoteEvent(ROOM, srv, '11', {
    type: 'my.room.breaker',
    sender: '@rudy:size.test',
    state_key: bigKey,
    content: {},
    prev_events: [tip],
  });
  const err = await assertRejects(() =>
    ingestEvent(ROOM, dropped, {
      remote: { origin: 'size.test', position: 'after' },
    })
  );
  assert(String(err).includes('M_BAD_EVENT'), String(err));
  // lenient version: the SAME state_key is accepted (codepoints)
  await resetRoom(ROOM10);
  await createRoom(ROOM10, '@dev:localhost', {
    roomVersion: '10',
    preset: 'public_chat',
    // the fake's state events need state power (rule 7 — state_default 50)
    powerLevelContentOverride: { users: { '@rudy:size.test': 100 } },
  });
  const tip10 = await latestExtremityEventId(ROOM10);
  const join10 = await remoteJoin(ROOM10, srv, '10', '@rudy:size.test', tip10);
  const create10 = await createIdOf(ROOM10);
  const lenient = await remoteEvent(ROOM10, srv, '10', {
    auth_events: [create10],
    type: 'my.room.breaker',
    sender: '@rudy:size.test',
    state_key: bigKey,
    content: {},
    prev_events: [join10],
  });
  await ingestEvent(ROOM10, lenient, {
    remote: { origin: 'size.test', position: 'after' },
  });
  // and a >255-CODEPOINT state_key in the lenient version is stored
  // rejected 'oversized'
  const hugeKey = '💥'.repeat(300); // 300 codepoints
  const huge = await remoteEvent(ROOM10, srv, '10', {
    auth_events: [create10],
    type: 'my.room.breaker',
    sender: '@rudy:size.test',
    state_key: hugeKey,
    content: {},
    prev_events: [join10],
  });
  // the event is STORED rejected 'oversized' (the error surfaces to the
  // caller — /send maps a stored rejection to {}, commit 4)
  const errH = await assertRejects(() =>
    ingestEvent(ROOM10, huge, {
      remote: { origin: 'size.test', position: 'after' },
    })
  );
  assert(String(errH).includes('M_STATE_REJECT'), String(errH));
  const rowH = (await indexRow(ROOM10, String(huge.event_id)))!;
  assertEquals(rowH.rejected, true);
  assertEquals(String(rowH.rejected_reason), 'oversized');

  wireFederationTransport();
});

Deno.test('ingest remote: room servers widen the witness set by seniority (roster first)', async () => {
  const ours = serverName();
  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM federation_peers;');
    await c.query(
      `INSERT INTO federation_peers (name, trust, added_ms, added_by) VALUES
        ('w1.test', 'ca', 1, 'operator'), ('w2.test', 'ca', 2, 'approval');`,
    );
    await c.query('DELETE FROM room_membership WHERE room_id = $1;', [ROOM]);
    await c.query(
      `INSERT INTO room_membership (room_id, user_id, membership, event_id, seq) VALUES
        ($1, '@a:${ours}', 'join', '$e0', 1),
        ($1, '@r1:d2.test', 'join', '$e1', 3),
        ($1, '@r2:d1.test', 'join', '$e2', 5),
        ($1, '@r3:d2.test', 'join', '$e3', 7);`,
      [ROOM],
    );
  });
  // roster first (seniority by added_ms), then the room's servers by the
  // seq of each server's earliest joined member (d2 at 3 before d1 at 5),
  // minus ourselves and the name being looked up
  const w = await listWitnesses({ roomId: ROOM, excludeName: 'd1.test' });
  assertEquals(w, ['w1.test', 'w2.test', 'd2.test']);
  // a room we are NOT in nominates nobody
  await withDb(serverDb(), async (c) => {
    await c.query(
      `UPDATE room_membership SET membership = 'leave' WHERE room_id = $1 AND user_id = $2;`,
      [ROOM, `@a:${ours}`],
    );
  });
  const w2 = await listWitnesses({ roomId: ROOM });
  assertEquals(w2, ['w1.test', 'w2.test']);
  await withDb(serverDb(), async (c) => {
    await c.query('DELETE FROM federation_peers;');
    await c.query('DELETE FROM room_membership WHERE room_id = $1;', [ROOM]);
  });
});
