// app.js — Alice & Bob page (matrix-sync MS2). Sign-in is nominal (no
// accounts, no network): Create makes a room (genesis events), Join builds
// an own store from events via the sync protocol (empty-tips delta-req).
import {
  createRoom, joinRoom, ingestEvent, ingestRemote, timeline, doltLog,
  tableHashes, extremities, rawQuery,
} from './engine-lite.js';
import { startMsync } from './sync/msync.js';
import { createTransport } from './sync/transport.js';

const $ = (id) => document.getElementById(id);
let room = null;
let ms = null;
let latestPeerTh = null;

// MS5: transport default — the ?transport= param wins; on localhost we
// default to BroadcastChannel (same-browser tabs); on any public host
// (Pages) we default to Trystero so two visitors on different machines
// never silently land on BroadcastChannel.
const transportKind = new URLSearchParams(location.search).get('transport')
  ?? (['localhost', '127.0.0.1'].includes(location.hostname) ? 'broadcast' : 'trystero');

const facade = {
  getRoom: () => room,
  extremities: (r) => extremities(r),
  tableHashes: (r) => tableHashes(r),
  ingestRemote: (r, e) => ingestRemote(r, e),
};

function renderTimeline() {
  const el = $('timeline');
  el.textContent = '';
  for (const e of timeline(room)) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.dataset.eventId = e.event_id;
    div.dataset.prevCount = String(e.prev_events.length);
    const body = document.createElement('span');
    body.className = 'body';
    body.textContent = e.type === 'm.room.message' ? e.content.body : `[${e.type}]`;
    const meta = document.createElement('span');
    meta.className = 'meta';
    meta.textContent = ` ${e.sender} · ${new Date(e.origin_ts).toLocaleTimeString()} `;
    const code = document.createElement('code');
    code.textContent = e.event_id;
    div.append(body, meta, code);
    el.append(div);
  }
}

function renderLog() {
  const el = $('doltlog');
  el.textContent = '';
  for (const c of doltLog(room, 25)) {
    const div = document.createElement('div');
    div.className = 'commit';
    div.dataset.hash = c.hash;
    div.textContent = `${c.hash}  ${c.message}`;
    el.append(div);
  }
}

function renderBadges() {
  const th = tableHashes(room);
  const mine = th.events.slice(0, 8);
  const theirs = latestPeerTh?.events?.slice(0, 8);
  const badge = $('convergence');
  if (theirs == null) {
    badge.textContent = `th: ${mine} (no peer yet)`;
    badge.className = 'badge diverged';
  } else if (theirs === mine) {
    badge.textContent = `th: ${mine} == peer ✓`;
    badge.className = 'badge ok';
  } else {
    badge.textContent = `th: mine ${mine} ≠ peer ${theirs}`;
    badge.className = 'badge diverged';
  }
  const exts = extremities(room);
  const fi = $('fork-ind');
  if (exts.length > 1) {
    fi.textContent = `${exts.length} tips — heals on next message`;
    fi.classList.remove('hidden');
  } else {
    fi.classList.add('hidden');
  }
}

function render() {
  if (!room) return;
  renderTimeline();
  renderLog();
  renderBadges();
}

async function start(role) {
  const name = $('name').value.trim();
  const roomName = $('room-name').value.trim();
  if (!name || !roomName) return;
  $('create-btn').disabled = true;
  $('join-btn').disabled = true;

  try {
    // MS4: never fail silently — every stage shows its status; any error
    // surfaces verbatim and re-enables the buttons.
    $('status').textContent = 'loading engine (wasm)…';
    room = role === 'create' ? await createRoom(name, roomName) : await joinRoom(name, roomName);
    window.__room = room;

    $('status').textContent = role === 'create' ? 'creating room…' : 'waiting for a peer to sync from…';
    if (role === 'create') {
      // creator reveal BEFORE transport (MS4): the room works solo while
      // transport connects; announce stays post-connect.
      $('join-screen').classList.add('hidden');
      $('room').classList.remove('hidden');
      render();
    }

    $('status').textContent = 'connecting transport…';
    const transport = createTransport(transportKind);
    ms = await startMsync({
      engine: facade, transport, roomName,
      joiner: role === 'join',
      onChange: () => {
        render();
        if (room.eventIndex.size > 0) {
          $('room').classList.remove('hidden');
          $('join-screen').classList.add('hidden');
        }
      },
      onPeerTh: (_from, th) => { latestPeerTh = th; renderBadges(); },
      onPeers: (peers) => { $('peers').textContent = `peers: ${peers.length}`; },
      onHeld: (held) => { $('status').textContent = `${held.length} events held (unknown prevs)`; },
    });
    window.__ms = ms;
    window.__syncPause = (v) => ms.pause(v);
    window.__syncStats = () => ms.stats();

    $('role').textContent = `role: ${role === 'create' ? 'creator' : 'joiner'}`;
    $('transport').textContent = `transport: ${transportKind}`;
    $('status').textContent = '';

    if (role === 'create') ms.announce();
    // join: the first delta's onChange reveals the room (status cleared there)
  } catch (e) {
    $('status').textContent = 'failed: ' + (e?.message ?? e);
    $('create-btn').disabled = false;
    $('join-btn').disabled = false;
    console.error(e);
  }
}

$('create-btn').addEventListener('click', () => start('create'));
$('join-btn').addEventListener('click', () => start('join'));

async function send() {
  const input = $('msg');
  const body = input.value.trim();
  if (!body || !room) return;
  input.value = '';
  await ingestEvent(room, { type: 'm.room.message', content: { body, msgtype: 'm.text' } });
  ms.announceLocalIngest();
  render();
}
$('send').addEventListener('click', send);
$('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

// MS5: join-screen copy additions (index.html is frozen this phase — the
// additions are injected from here by design). The session-scoped storage
// notice in index.html stays as-is.
{
  const note = document.createElement('div');
  note.style.cssText = 'flex-basis: 100%; font-size: 0.85rem; opacity: 0.8;';
  note.textContent = 'Rooms are joinable by name over public relays — pick something unique.';
  const suggest = document.createElement('button');
  suggest.type = 'button';
  suggest.textContent = 'suggest';
  suggest.style.fontSize = '0.8rem';
  suggest.addEventListener('click', () => {
    $('room-name').value = 'room-' + crypto.getRandomValues(new Uint8Array(2))
      .reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
  });
  const js = $('join-screen');
  js.append(note, suggest);
}

$('runsql').addEventListener('click', () => {
  const out = $('sqlresult');
  out.textContent = '';
  try {
    const { columns, rows } = rawQuery(room, $('sql').value);
    const table = document.createElement('table');
    table.className = 'results';
    const tr = document.createElement('tr');
    for (const c of columns) { const th = document.createElement('th'); th.textContent = c; tr.append(th); }
    table.append(tr);
    for (const r of rows) {
      const tr2 = document.createElement('tr');
      for (const v of r) { const td = document.createElement('td'); td.textContent = String(v ?? 'NULL'); tr2.append(td); }
      table.append(tr2);
    }
    if (!rows.length) table.append(Object.assign(document.createElement('caption'), { textContent: '(0 rows)' }));
    out.append(table);
  } catch (e) {
    out.textContent = 'error: ' + e.message;
  }
});
