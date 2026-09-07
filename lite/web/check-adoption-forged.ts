// lite/web/check-adoption-forged.ts — F0 gate: a peer image with a
// forged conflict-free `state` row is refused (dropped), and the
// adopting peer's history is intact after restart. Headless: drives
// engine-lite.js directly (DoltLite WASM runs in Deno), no browser.
import {
  adoptStoreImage,
  aliveBranches,
  allEvents,
  branchesInImage,
  createRoom,
  exportStoreImage,
  extremities,
  ingestEvent,
  joinRoom,
  sqlite3Module,
  stateHash,
} from './engine-lite.js';

let ok = true;
const fail = (msg: string) => {
  ok = false;
  console.error('ASSERT-FAIL:', msg);
};

// Victim builds a real room with history.
const V = await createRoom('victim', 'adopt-victim');
await ingestEvent(V, {
  type: 'm.room.message', content: { body: 'real-1', msgtype: 'm.text' },
});
await ingestEvent(V, {
  type: 'm.room.topic', state_key: '', content: { topic: 'real-topic' },
});
const beforeEvents = allEvents(V).length;
const beforeTips = extremities(V).map((e) => e.eventId).sort().join(',');

// Attacker copies the victim's image and forges a conflict-free state row
// (same keys, no event behind the forged topic) + a forged event id ref.
const sqlite3 = await sqlite3Module();
const img = new Uint8Array(await exportStoreImage(V));
const forgePath = '/forge-attacker.db';
sqlite3.capi.sqlite3_js_vfs_create_file('unix', forgePath, img, img.byteLength);
const fdb = new sqlite3.oo1.DB(forgePath);
// (Fresh opens land on main — read across the x* branches like adoption.)
const xbr = (
  fdb.selectObjects('SELECT name FROM dolt_branches') as { name: string }[]
).map((r) => r.name).filter((n) => typeof n === 'string' && n.startsWith('x'));
let stateBefore: { event_id: string }[] = [];
for (const b of xbr) {
  fdb.exec(`SELECT dolt_checkout('${b}')`);
  stateBefore = fdb.selectObjects(
    'SELECT type, state_key, event_id FROM state',
  ) as { event_id: string }[];
}
console.log(`forger: image state rows=${stateBefore.length} events=${fdb.selectValue('SELECT COUNT(*) FROM events')}`);
fdb.exec({
  sql: 'UPDATE state SET event_id = ?, content = ? WHERE type = ? AND state_key = ?',
  bind: ['$forged-no-such-event', '{"topic":"pwned"}', 'm.room.topic', ''],
});
const forgedCheck = fdb.selectObjects(
  `SELECT event_id FROM state WHERE event_id = '$forged-no-such-event'`,
);
if (forgedCheck.length !== 1) fail('forger setup broken: forged row missing pre-adoption');
const forgedImg = sqlite3.capi.sqlite3_js_db_export(fdb.pointer);
fdb.close();

// The adopter takes the FORGED image (branch list from the receiver-side
// probe, as on the trystero binary path).
const forgedBytes = new Uint8Array(
  forgedImg.buffer.slice(forgedImg.byteOffset, forgedImg.byteOffset + forgedImg.byteLength),
);
const D = await joinRoom('dave', 'adopt-dave');
const res = await adoptStoreImage(
  D,
  forgedBytes,
  'forger',
  (await branchesInImage(forgedBytes)).length
    ? await branchesInImage(forgedBytes)
    : aliveBranches(V),
);
console.log(`adopt result: ${JSON.stringify(res)}`);

// The forged row must be gone: replay never reads image state.
const topicRows = D.db.selectObjects(
  `SELECT event_id, content FROM state WHERE type = 'm.room.topic'`,
) as { event_id: string; content: string }[];
if (topicRows.some((r) => String(r.event_id).includes('forged'))) {
  fail('forged state row survived adoption');
}
const realTopic = topicRows.find((r) => String(r.content).includes('real-topic'));
if (!realTopic) fail('real topic lost in adoption');

// History intact: all of the victim's events present with equal ids.
const dIds = new Set(
  (allEvents(D) as Record<string, unknown>[]).map((e) => String(e.event_id)),
);
const vIds = (allEvents(V) as Record<string, unknown>[]).map((e) => String(e.event_id));
for (const id of vIds) {
  if (!dIds.has(id)) fail(`adopted history missing ${id}`);
}
if (allEvents(D).length !== beforeEvents) {
  fail(`event count changed: ${allEvents(D).length} vs ${beforeEvents}`);
}
if (extremities(D).map((e) => e.eventId).sort().join(',') !== beforeTips) {
  fail('extremity set changed by adoption');
}
// sh converges (same frontier, same resolution).
if ((await stateHash(D)) !== (await stateHash(V))) fail('sh diverged after adoption');

console.log(
  `adoption-forged: events=${allEvents(D).length} sh=${await stateHash(D)} refused=${res.refused ?? 'none'}`,
);
if (ok) console.log('CHECK: PASS');
else {
  console.error('CHECK: FAIL');
  Deno.exit(1);
}
