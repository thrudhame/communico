import { assert, assertEquals } from '@std/assert';
import { createRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { getFacadeFor } from '#engine/facade.ts';
import type { Pdu } from '#engine/pdu.ts';
import { latestExtremityEventId, resetRoom } from './util.ts';

const ROOM = '!t6:localhost';

// A wire pdu exactly as a peer mints it: authored (depth, auth_events,
// hashes, id, server signature) through the same pipeline a remote
// origin would use. Membership coverage lives in policy.test.ts; here
// events send as the joined dev user.
function makePdu(
  prevs: string[],
  body: string,
  ts: number,
): Promise<Record<string, unknown>> {
  return author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body, msgtype: 'm.text' },
    prev_events: prevs,
    origin_server_ts: ts,
  }) as unknown as Promise<Record<string, unknown>>;
}

Deno.test('lite-hat facade: bad / known / held+drain / fork / heal / refused', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const facade = (await getFacadeFor(ROOM))!;
  const room = facade.getRoom()!;

  // open-scan mirrored the genesis events
  assertEquals(await facade.eventCount(room), 4);
  assertEquals(facade.engineName, 'doltgres');
  assertEquals(await facade.roomVersion(room), '11');
  const tip = await latestExtremityEventId(ROOM);
  assert(await facade.hasEvent(room, tip));

  // bad: tampered id fails recomputation
  const bad = await makePdu([tip], 'bad', 1000);
  bad.event_id = '$' + 'A'.repeat(43);
  const rb = await facade.ingestRemote(room, bad);
  assert(rb.bad, 'tampered id must be bad');
  assertEquals(await facade.badEvents(room), 1);
  assertEquals(await facade.eventCount(room), 4, 'bad event must not land');

  // apply a well-formed remote event (prev = current tip)
  const e1 = await makePdu([tip], 'remote-1', 2000);
  const r1 = await facade.ingestRemote(room, e1);
  assert(r1.applied, 'well-formed event must apply: ' + JSON.stringify(r1));
  assert(await facade.hasEvent(room, e1.event_id as string));

  // known: same pdu again
  const rk = await facade.ingestRemote(room, e1);
  assert(rk.known, 're-delivery must be known');
  assertEquals(await facade.eventCount(room), 5);

  // held: e2 lands in the DB directly (mirror unaware), e3 is authored
  // against it, then e3 reaches the facade first and holds on the
  // unknown-to-mirror prev; e2's arrival applies it via the drain.
  const e2 = await makePdu([e1.event_id as string], 'remote-2', 4000);
  await ingestEvent(ROOM, e2 as unknown as Pdu);
  const e3 = await makePdu([e2.event_id as string], 'remote-3', 5000);
  const rh = await facade.ingestRemote(room, e3);
  assert(rh.held, 'unknown prev must hold');
  assert(!(await facade.hasEvent(room, e3.event_id as string)));
  const r2 = await facade.ingestRemote(room, e2);
  assert(r2.applied, 'redelivered known event applies idempotently');
  assert(
    await facade.hasEvent(room, e3.event_id as string),
    'drain must apply the held event once its prev lands',
  );

  // fork: a local (CS-hat) send consumes the tip; a remote event off the
  // OLD tip must still land (prev branch re-materialized, MS0 route)
  const localPdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'local', msgtype: 'm.text' },
    prev_events: [e3.event_id as string],
    origin_server_ts: 6000,
  });
  const local = await ingestEvent(ROOM, localPdu);
  await facade.noteApplied(local.event_id);
  assert(await facade.hasEvent(room, local.event_id));
  const forkEvt = await makePdu([e3.event_id as string], 'fork-off-stale-tip', 7000);
  const rf = await facade.ingestRemote(room, forkEvt);
  assert(rf.applied, 'stale-prev event must land via re-materialization');
  const exts = await facade.extremities(room);
  assertEquals(exts.length, 2, 'fork must yield two extremities');

  // heal over messages (uncontested) converges via the merge driver
  const heal = await makePdu(exts.map((e) => e.eventId), 'heal', 8000);
  const rh2 = await facade.ingestRemote(room, heal);
  assert(rh2.applied, 'uncontested heal must apply');
  assertEquals(await facade.merges(room), 1);
  assertEquals((await facade.extremities(room)).length, 1, 'healed');

  // sh is present on the converged frontier, versioned, id-based
  const sh = await facade.stateHash(room);
  assert(sh && /^[0-9a-f]{64}$/.test(sh), 'sh must be a 64-hex digest');

  // allEvents serves the full mirror (delta source)
  const all = await facade.allEvents(room);
  assert(all.some((p) => p.event_id === heal.event_id));
  assertEquals(await facade.eventCount(room), 4 + 1 + 2 + 1 + 1 + 1);
});

// Tampered-signature vectors (F1 gate): content tampering breaks the id
// (bad); signature stripping keeps a valid id but has no trust (refused);
// transplanted signatures from a sibling event fail verification
// (refused). Nothing forged enters the DAG as applied.
Deno.test('lite-hat facade: tampered signatures are rejected', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  const facade = (await getFacadeFor(ROOM))!;
  const room = facade.getRoom()!;
  const tip = await latestExtremityEventId(ROOM);
  // Distinct mints per vector, authored but NOT pre-ingested: same-id
  // redelivery (even of rejected rows) takes the idempotent path, which
  // would mask the vectors. First vector ingest consumes the tip branch;
  // later vectors ride the MS0 re-materialization fork — refusal reasons
  // are unaffected.
  const mk = (body: string, ts: number) =>
    author(ROOM, {
      type: 'm.room.message',
      sender: '@dev:localhost',
      content: { body, msgtype: 'm.text' },
      prev_events: [tip],
      origin_server_ts: ts,
    });

  // (a) content tamper → declared content hash mismatches → the event is
  // processed as rejected (spec: hash failure redacts before processing),
  // refused with M_AUTHCHAIN_REJECT, flagged in the index, out of state.
  const m1 = await mk('tamper-a', 1000);
  const t1 = structuredClone(m1) as unknown as Record<string, unknown>;
  (t1.content as Record<string, unknown>).body = 'forged';
  const r1 = await facade.ingestRemote(room, t1);
  assert(r1.refused, `tampered content must be refused: ${JSON.stringify(r1)}`);
  assert(String(r1.reason).includes('M_AUTHCHAIN_REJECT'));

  // (b) stripped signatures → id recomputes, trust does not → refused.
  const m2 = await mk('tamper-b', 2000);
  const t2 = structuredClone(m2) as unknown as Record<string, unknown>;
  t2.signatures = {};
  const r2 = await facade.ingestRemote(room, t2);
  assert(r2.refused, `stripped signature must be refused: ${JSON.stringify(r2)}`);
  assert(String(r2.reason).includes('M_UNAUTHORIZED'));

  // (c) transplanted sibling signature → verification fails → refused.
  const m3a = await mk('tamper-c1', 3000);
  const m3b = await mk('tamper-c2', 4000);
  const t3 = structuredClone(m3b) as unknown as Record<string, unknown>;
  t3.signatures = structuredClone(m3a.signatures);
  const r3 = await facade.ingestRemote(room, t3);
  assert(r3.refused, `transplanted signature must be refused: ${JSON.stringify(r3)}`);

  // an unmolested mint still applies afterwards (fresh prev).
  const m0 = await mk('pristine', 5000);
  const r0 = await facade.ingestRemote(room, m0 as unknown as Record<string, unknown>);
  assert(r0.applied, 'pristine PDU must apply');
});

// A conflicting heal through the facade surfaces {refused} — and sh goes
// absent on the contested frontier.
Deno.test('lite-hat facade: conflicting heal is refused, sh absent', async () => {
  await resetRoom(ROOM);
  await createRoom(ROOM, '11', '@dev:localhost');
  // fresh facade (the module caches per room — bust by room reset)
  const facade = (await getFacadeFor(ROOM))!;
  const room = facade.getRoom()!;

  const tip = await latestExtremityEventId(ROOM);
  const mkTopic = (body: string, prev: string, ts: number) =>
    author(ROOM, {
      type: 'm.room.topic',
      state_key: '',
      sender: '@dev:localhost',
      content: { topic: body },
      prev_events: [prev],
      origin_server_ts: ts,
    });
  const t1 = await ingestEvent(ROOM, await mkTopic('cats', tip, 1000), {
    keepPrevBranches: true,
  });
  const t2pdu = await mkTopic('dogs', tip, 2000);
  const t2 = await ingestEvent(ROOM, t2pdu as unknown as Pdu);
  void t1;
  await facade.noteApplied(t2.event_id);
  const forkPdu = await mkTopic('cats-remote', tip, 1500);
  const rf = await facade.ingestRemote(
    room,
    forkPdu as unknown as Record<string, unknown>,
  );
  assert(rf.applied, 'stale-prev topic must land as a fork');

  const healPdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { body: 'heal', msgtype: 'm.text' },
    prev_events: [t2.event_id, forkPdu.event_id!],
    origin_server_ts: 3000,
  }).catch(() => null);
  assertEquals(healPdu, null, 'author itself refuses the conflicting heal');

  // contested frontier -> sh absent, not different
  const sh = await facade.stateHash(room);
  assertEquals(sh, null, 'sh must be absent on contested keys');
});
