// MS1 longevity harness (phase-ms1-3): 20 alternating generations across
// TWO in-page engines wired through the REAL msync protocol over a
// BroadcastChannel loopback. Per-gen `MS1-GEN <n>: ok (<ms>)`, table-hash
// equality asserted each gen. Watchdogs: a wasm hang never yields to the
// event loop, so the 15 s bound is enforced by the caller's timeout +
// per-gen lines marking the last clean generation (recorded mapping).
import {
  createRoom, joinRoom, ingestEvent, ingestRemote, extremities, tableHashes,
  allEvents, hasEvent, eventCount,
} from './engine-lite.js';
import { startMsync } from './sync/msync.js';
import { createTransport } from './sync/transport.js';

const out = document.querySelector('#results');
out.textContent = '';
const line = (s) => { out.textContent += s + '\n'; };

const ROOM = 'mslongevity';

// BroadcastChannel same-page loopback note: per the spec a message posted
// to a channel is delivered to every other BroadcastChannel object on it
// EXCEPT the poster — including within ONE document. Verified live here:
const bcProbe = new BroadcastChannel('communico-lite:probe');
const bcProbe2 = new BroadcastChannel('communico-lite:probe');
const loopOk = await new Promise((resolve) => {
  bcProbe2.onmessage = () => resolve(true);
  bcProbe.postMessage('ping');
  setTimeout(() => resolve(false), 1500);
});
line(`INFO same-page BroadcastChannel delivery: ${loopOk ? 'WORKS' : 'BROKEN'}`);
bcProbe.close(); bcProbe2.close();
if (!loopOk) {
  line('MS1-LONGEVITY: FAIL — BroadcastChannel does not loop back in-page');
  throw new Error('BC loopback broken');
}

function facadeFor(getR) {
  return {
    engineName: 'doltlite',
    getRoom: getR,
    extremities: (r) => extremities(r),
    tableHashes: (r) => tableHashes(r),
    ingestRemote: (r, e) => ingestRemote(r, e),
    allEvents: (r) => allEvents(r),
    hasEvent: (r, id) => hasEvent(r, id),
    eventCount: (r) => eventCount(r),
    badEvents: (r) => r.badEvents,
    merges: (r) => r.merges,
  };
}

let roomC = null;
let roomD = null;
roomC = await createRoom('carol', ROOM);
roomD = await joinRoom('dan', ROOM);

const tr = createTransport('broadcast');
const msC = await startMsync({ engine: facadeFor(() => roomC), transport: tr, roomName: ROOM });
const msD = await startMsync({ engine: facadeFor(() => roomD), transport: tr, roomName: ROOM, joiner: true });

// wait for D to bootstrap genesis from C (join = empty-tips delta)
{
  const deadline = Date.now() + 15_000;
  while (roomD.eventIndex.size === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (roomD.eventIndex.size === 0) {
    line('MS1-LONGEVITY: FAIL — D never bootstrapped genesis via delta');
    throw new Error('join bootstrap failed');
  }
  const eq = tableHashes(roomC).events === tableHashes(roomD).events;
  line(`INFO join bootstrap: D applied genesis via delta (${roomD.eventIndex.size} events); table hash equal: ${eq}`);
  if (!eq) throw new Error('post-join table hashes differ');
}

const times = [];
let hangAt = null;
for (let g = 1; g <= 20; g++) {
  const senderIsC = g % 2 === 1;
  const sender = senderIsC ? roomC : roomD;
  const ms = senderIsC ? msC : msD;
  const t0 = performance.now();
  await ingestEvent(sender, { type: 'm.room.message', content: { body: `gen-${g}`, msgtype: 'm.text' } });
  ms.announceLocalIngest();
  // wait for the peer to converge (equal table hashes), 15 s bound
  const deadline = Date.now() + 15_000;
  let equal = false;
  while (Date.now() < deadline) {
    const a = tableHashes(roomC); const b = tableHashes(roomD);
    if (a.events === b.events && a.state === b.state) { equal = true; break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  const msElapsed = Math.round(performance.now() - t0);
  if (!equal) {
    hangAt = g;
    line(`MS1-LONGEVITY: ${g - 1}/20 — hung at gen ${g} (peer never converged within 15 s)`);
    break;
  }
  times.push(msElapsed);
  line(`MS1-GEN ${g}: ok (${msElapsed} ms; sender=${senderIsC ? 'C' : 'D'}; th ${tableHashes(roomC).events.slice(0, 8)})`);
}
if (!hangAt) {
  line(`MS1-LONGEVITY: 20/20 GENERATIONS CLEAN (per-gen ms: first=${times[0]} last=${times[times.length - 1]} min=${Math.min(...times)} max=${Math.max(...times)})`);
  line(`INFO stats C: ${JSON.stringify(msC.stats())} D: ${JSON.stringify(msD.stats())}`);
}
