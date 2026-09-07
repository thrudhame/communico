// lite/web/check-fork-refusal.ts — F0 gate: two browser engines in ONE
// room make a concurrent power-levels edit (far-apart timestamps).
// BOTH must surface the refusal, NEITHER may materialize a winner, and
// sh must be ABSENT for the contested key (tips may agree — that is not
// the assertion). Headless: drives engine-lite.js directly (DoltLite
// WASM runs in Deno), no browser.
import {
  adoptStoreImage,
  aliveBranches,
  allEvents,
  createRoom,
  exportStoreImage,
  extremities,
  ingestEvent,
  ingestRemote,
  joinRoom,
  stateHash,
} from './engine-lite.js';

let ok = true;
const fail = (msg: string) => {
  ok = false;
  console.error('ASSERT-FAIL:', msg);
};

const pduOf = (room: unknown, id: string) =>
  ((allEvents as (r: unknown) => Record<string, unknown>[])(room)).find(
    (e) => e.event_id === id,
  )!;

// 1. A creates; alice invites bob; bob joins (all through the stub).
const A = await createRoom('alice', 'fork-a');
const BOB = '@bob:browser';
let tip = extremities(A)[0].eventId;
const invite = await ingestEvent(A, {
  type: 'm.room.member', state_key: BOB, content: { membership: 'invite' },
}, [tip]);
const join = await ingestEvent(A, {
  type: 'm.room.member', state_key: BOB, sender: BOB,
  content: { membership: 'join' },
}, [invite.event_id]);
tip = join.event_id;

// 2. B joins by adopting A's image (same room, same membership).
const B = await joinRoom('bob', 'fork-b');
const adopted = await adoptStoreImage(
  B,
  new Uint8Array(await exportStoreImage(A)),
  'a',
  aliveBranches(A),
);
if (!adopted.applied || adopted.refused) {
  fail(`B bootstrap failed: ${JSON.stringify(adopted)}`);
}
if (extremities(B)[0].eventId !== tip) fail('B did not converge on bootstrap');

// 3. Concurrent PL edits off the same base, far-apart timestamps.
const plA = await ingestEvent(A, {
  type: 'm.room.power_levels', state_key: '',
  content: { state_default: 0 },
}, [tip]);
const plB = await ingestEvent(B, {
  type: 'm.room.power_levels', state_key: '',
  sender: BOB, content: { state_default: 100 },
  origin_ts: 9999999999999,
}, [tip]);

// 4. Cross-deliver: each lands as a fork (both authorized members).
// (Snapshot both PDUs first — allEvents reads the checked-out branch,
// so fetching after the first delivery would miss the sibling tip.)
const pduA = pduOf(A, plA.event_id);
const pduB = pduOf(B, plB.event_id);
const rA = await ingestRemote(A, pduB);
const rB = await ingestRemote(B, pduA);
if (!rA.applied) fail(`A did not apply bob's fork: ${JSON.stringify(rA)}`);
if (!rB.applied) fail(`B did not apply alice's fork: ${JSON.stringify(rB)}`);

// 5. Heal attempts on both sides must refuse (timestamps decide nothing).
let healRefusedA = false;
try {
  await ingestEvent(A, {
    type: 'm.room.message', content: { body: 'heal', msgtype: 'm.text' },
  }, [plA.event_id, plB.event_id]);
} catch (e) {
  healRefusedA = String(e).includes('M_UNRESOLVED_CONFLICT');
}
if (!healRefusedA) fail('A did not refuse the conflicting heal');
let healRefusedB = false;
try {
  await ingestEvent(B, {
    type: 'm.room.message', content: { body: 'heal', msgtype: 'm.text' },
  }, [plA.event_id, plB.event_id]);
} catch (e) {
  healRefusedB = String(e).includes('M_UNRESOLVED_CONFLICT');
}
if (!healRefusedB) fail('B did not refuse the conflicting heal');

// 6. Neither materialized a winner: still forked, sh absent both sides.
if (extremities(A).length < 2) fail('A collapsed the fork (guessed a winner)');
if (extremities(B).length < 2) fail('B collapsed the fork (guessed a winner)');
if ((await stateHash(A)) !== null) fail('A reports sh on contested keys');
if ((await stateHash(B)) !== null) fail('B reports sh on contested keys');

console.log(
  `fork-refusal: healA refused=${healRefusedA} healB refused=${healRefusedB} ` +
    `extA=${extremities(A).length} extB=${extremities(B).length} ` +
    `shA=${await stateHash(A)} shB=${await stateHash(B)}`,
);
if (ok) console.log('CHECK: PASS');
else {
  console.error('CHECK: FAIL');
  Deno.exit(1);
}
