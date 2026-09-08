// app.js — Alice & Bob page (matrix-sync MS2). Sign-in is nominal (no
// accounts, no network): Create makes a room (genesis events), Join builds
// an own store from events via the sync protocol (empty-tips delta-req).
import {
  createRoom, joinRoom, ingestEvent, ingestRemote, timeline, doltLog,
  tableHashes, stateHash, roomVersion, extremities, allEvents, hasEvent,
  eventCount, rawQuery,
  exportStoreImage, aliveBranches, adoptStoreImage, branchesInImage,
  ensureIdentity, createProfile, switchProfile, identityInfo, activeMxid,
  exportIdentity, importIdentity,
} from './engine-lite.js';
import { startMsync } from './sync/msync.js';
import { startDsync } from './sync/dsync.js';
import { createTransport } from './sync/transport.js';

const $ = (id) => document.getElementById(id);
let room = null;
let ms = null;
let latestPeerTh = null;   // {engine, events, state} — advisory; comparable only when .engine matches
let latestPeerTips = null; // [eventId] — the convergence badge compares tip SETS (cross-engine safe)
let pendingAnnounce = false; // a message landed before transport was ready

// MS5: transport default — the ?transport= param wins; on localhost we
// default to BroadcastChannel (same-browser tabs); on any public host
// (Pages) we default to Trystero so two visitors on different machines
// never silently land on BroadcastChannel.
const transportKind = new URLSearchParams(location.search).get('transport')
  ?? (['localhost', '127.0.0.1'].includes(location.hostname) ? 'broadcast' : 'trystero');

// v1b (§9.2 ruling): sync mode is selectable — dolt-native (store bytes →
// file:// remote → dolt_fetch + driver merge) is the default; ?sync=msync
// keeps the custom event-sync protocol for A/B against v0/v1a.
const syncKind = new URLSearchParams(location.search).get('sync') ?? 'dolt';

const ENGINE_NAME = 'doltlite';
const facade = {
  engineName: ENGINE_NAME,
  getRoom: () => room,
  extremities: (r) => extremities(r),
  tableHashes: (r) => tableHashes(r),
  stateHash: (r) => stateHash(r),
  roomVersion: (r) => roomVersion(r),
  ingestRemote: (r, e) => ingestRemote(r, e),
  allEvents: (r) => allEvents(r),
  hasEvent: (r, id) => hasEvent(r, id),
  eventCount: (r) => eventCount(r),
  badEvents: (r) => r.badEvents,
  merges: (r) => r.merges,
  exportStoreImage: (r) => exportStoreImage(r),
  aliveBranches: (r) => aliveBranches(r),
  adoptStoreImage: (r, bytes, peerId, branches) => adoptStoreImage(r, bytes, peerId, branches),
  branchesInImage: (bytes) => branchesInImage(bytes),
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
  const badge = $('convergence');
  // Green = tips-SET equality (cross-engine safe — a gres peer's table
  // hashes live in a different hash universe and can never match ours).
  // th equality is shown only when the peer runs the same engine.
  if (latestPeerTips == null) {
    badge.textContent = `th: ${mine} (no peer yet)`;
    badge.className = 'badge diverged';
  } else {
    const myTips = extremities(room).map((e) => e.eventId).sort().join(',');
    const peerTips = [...latestPeerTips].sort().join(',');
    const sameEngine = latestPeerTh?.engine === ENGINE_NAME;
    const thNote = sameEngine
      ? ` · th ${mine}${latestPeerTh?.events?.slice(0, 8) === mine ? ' ==' : ' ≠'} peer`
      : '';
    if (myTips === peerTips) {
      badge.textContent = `tips == peer ✓${thNote}`;
      badge.className = 'badge ok';
    } else {
      badge.textContent = `tips diverged from peer${thNote}`;
      badge.className = 'badge diverged';
    }
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

async function refreshProfiles() {
  const info = identityInfo() ?? { serverName: '', profiles: [], active: null };
  const sel = $('profile');
  sel.textContent = '';
  for (const p of info.profiles) {
    const opt = document.createElement('option');
    opt.value = p.localpart;
    opt.textContent = `@${p.localpart} (${p.displayname})`;
    if (p.localpart === info.active) opt.selected = true;
    sel.append(opt);
  }
  $('my-id').textContent = info.active ? `@${info.active}:${info.serverName}` : info.serverName;
  window.__identity = info;
}

async function leaveRoom() {
  try { ms?.leave(); } catch { /* closing anyway */ }
  ms = null;
  room = null;
  window.__room = null;
  window.__ms = null;
  $('room').classList.add('hidden');
  $('join-screen').classList.remove('hidden');
  $('create-btn').disabled = false;
  $('join-btn').disabled = false;
}

async function start(role) {
  const name = $('name').value.trim();
  const roomName = $('room-name').value.trim();
  if (!name || !roomName) return;
  // personas: the name field is a localpart (fixed at creation); the same
  // field seeds the displayname. Rooms belong to the active profile.
  await ensureIdentity();
  await createProfile(name, name);
  await refreshProfiles();
  $('create-btn').disabled = true;
  $('join-btn').disabled = true;

  try {
    // MS4: never fail silently — every stage shows its status; any error
    // surfaces verbatim and re-enables the buttons.
    $('status').textContent = 'loading engine (wasm)…';
    // ws transport = the lite hat: the room NAME is the server room's id,
    // and our PDUs must carry it (the content-hash id covers room_id).
    const roomId = transportKind === 'ws' ? roomName : null;
    room = role === 'create'
      ? await createRoom(name, roomName, roomId)
      : await joinRoom(name, roomName, roomId);
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
    const startSync = syncKind === 'msync' ? startMsync : startDsync;
    ms = await startSync({
      engine: facade, transport, roomName,
      joiner: role === 'join',
      onChange: () => {
        render();
        if (room.eventIndex.size > 0) {
          $('room').classList.remove('hidden');
          $('join-screen').classList.add('hidden');
        }
      },
      onPeerTh: (_from, th, tips) => { latestPeerTh = th; latestPeerTips = tips; renderBadges(); },
      onPeers: (peers) => { $('peers').textContent = `peers: ${peers.length}`; },
      onHeld: (held) => { $('status').textContent = `${held.length} events held (unknown prevs)`; },
    });
    window.__ms = ms;
    window.__syncPause = (v) => ms.pause(v);
    window.__syncStats = () => ms.stats();

    $('role').textContent = `role: ${role === 'create' ? 'creator' : 'joiner'}`;
    $('transport').textContent = `transport: ${transportKind}`;
    $('syncmode').textContent = `sync: ${syncKind}`;
    $('status').textContent = '';

    if (role === 'create') ms.announce();
    if (pendingAnnounce) { ms.announce(); pendingAnnounce = false; }
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
$('profile').addEventListener('change', async () => {
  const lp = $('profile').value;
  if (!lp) return;
  await switchProfile(lp);
  await refreshProfiles();
  // rooms belong to a profile: leaving keeps the store only for the
  // session, so a profile switch unloads (re-join bootstraps via sync).
  if (room && room.profile !== lp) await leaveRoom();
});
$('rename-btn').addEventListener('click', async () => {
  const info = identityInfo();
  const dn = $('displayname').value.trim();
  if (!info?.active || !dn) return;
  await createProfile(info.active, dn);
  await refreshProfiles();
});
$('export-btn').addEventListener('click', async () => {
  const blob = await exportIdentity();
  // portability: the whole browser key (every profile moves with it)
  await navigator.clipboard?.writeText(JSON.stringify(blob)).catch(() => {});
  $('status').textContent = 'key exported to clipboard (moves every profile)';
});
$('import-btn').addEventListener('click', async () => {
  const raw = window.prompt('paste an exported browser key:');
  if (!raw) return;
  try {
    await importIdentity(JSON.parse(raw));
    await refreshProfiles();
    await leaveRoom();
    $('status').textContent = 'key imported — re-join rooms under its profiles';
  } catch (e) {
    $('status').textContent = 'import failed: ' + (e?.message ?? e);
  }
});
$('invite-btn').addEventListener('click', async () => {
  const target = $('invite-name').value.trim();
  if (!target || !room || !ms) return;
  // localpart (this homeserver) or full @user:<key> MXID.
  const stateKey = target.includes(':') ? target : `@${target}:${identityInfo()?.serverName}`;
  try {
    await ingestEvent(room, {
      type: 'm.room.member', state_key: stateKey,
      sender: room.self,
      content: { membership: 'invite' },
    });
    render();
    ms.announceLocalIngest();
  } catch (e) {
    $('status').textContent = 'invite refused: ' + String(e?.message ?? e).split(':')[0];
  }
});
$('join-room-btn').addEventListener('click', async () => {
  if (!room || !ms) return;
  try {
    await ingestEvent(room, {
      type: 'm.room.member', state_key: room.self, sender: room.self,
      content: {
        membership: 'join',
        displayname: identityInfo()?.profiles.find((p) => `@${p.localpart}:${identityInfo()?.serverName}` === room.self)?.displayname ?? room.self,
      },
    });
    render();
    ms.announceLocalIngest();
  } catch (e) {
    $('status').textContent = 'join refused: ' + String(e?.message ?? e).split(':')[0];
  }
});

async function send() {
  const input = $('msg');
  const body = input.value.trim();
  if (!body || !room) return;
  input.value = '';
  // F0 stub: a refused send is still stored in the DAG (rejected, out of
  // state) and must still render + gossip — refusal is a materialization
  // decision, never a propagation drop. Surface it in the status line.
  try {
    await ingestEvent(room, { type: 'm.room.message', content: { body, msgtype: 'm.text' } });
  } catch (e) {
    $('status').textContent = 'send refused, kept locally: ' + String(e?.message ?? e).split(':')[0];
  }
  render(); // local truth first — never blocked by transport readiness
  if (ms) {
    ms.announceLocalIngest();
  } else {
    // transport still connecting (public relays can be slow): the event is
    // safely committed; announce as soon as startMsync resolves.
    pendingAnnounce = true;
    $('status').textContent = 'connecting transport… (message saved locally)';
  }
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

// ?room= prefills the room name — the Carol URL hands the server room id
// to the browser leg (demo/setup.sh prints the full link).
{
  const pre = new URLSearchParams(location.search).get('room');
  if (pre) $('room-name').value = pre;
}

// identity bootstraps on page load (mint-on-first-run happens here, so
// the picker and my-id badge are live before any room is created).
void (async () => {
  try {
    await ensureIdentity();
    await refreshProfiles();
  } catch (e) {
    console.error('identity init:', e);
  }
})();

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
