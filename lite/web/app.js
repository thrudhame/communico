// app.js — POC page glue: sign in → createRoom; send → ingestEvent;
// refresh timeline + live dolt_log pane after every send; SQL console.
import { createRoom, ingestEvent, timeline, doltLog, rawQuery } from './engine-lite.js';

const $ = (id) => document.getElementById(id);
let room = null;

function renderTimeline() {
  const el = $('timeline');
  el.textContent = '';
  for (const e of timeline(room)) {
    const div = document.createElement('div');
    div.className = 'msg';
    div.dataset.eventId = e.event_id;
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

async function send() {
  const input = $('msg');
  const body = input.value.trim();
  if (!body) return;
  input.value = '';
  await ingestEvent(room, {
    type: 'm.room.message', sender: room.self,
    content: { body, msgtype: 'm.text' },
    prev_events: room.extremities.map((e) => e.wireId),
    origin_ts: Date.now(),
  });
  renderTimeline();
  renderLog();
}

$('signin-btn').addEventListener('click', async () => {
  const name = $('name').value.trim();
  if (!name) return;
  $('signin-btn').disabled = true;
  $('status').textContent = 'building your room (wasm)…';
  room = await createRoom(name);
  window.__room = room; // debugging handle
  if (!room.persistent) $('session-note').classList.remove('hidden');
  $('signin').classList.add('hidden');
  $('room').classList.remove('hidden');
  renderTimeline();
  renderLog();
});

$('send').addEventListener('click', send);
$('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });

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
