// api/engine/room/materialize.ts — R4–R7: the only writer of state_groups,
// state_entries, event_state, publications and the current-state pointer.
// A group is a snapshot (parent NULL, depth 0) or a delta on a parent
// (depth = parent + 1; beyond 32 the group is written as a snapshot).
// Groups are content: an identical change set on the same parent reuses
// the existing group via the UNIQUE fingerprint, and a zero-change
// newGroup returns the parent (R4; dedup documented in the stage notes).
import type { Conn } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import {
  groupEntries,
  groupKey,
  type StateChange,
} from '#engine/room/state.ts';

export const SNAPSHOT_DEPTH = 32;

function canonical(entries: readonly StateChange[]): string {
  return JSON.stringify(
    [...entries]
      .map((entry) => [entry.type, entry.state_key, entry.event])
      .sort((a, b) => {
        if (a[0] !== b[0]) return String(a[0]) < String(b[0]) ? -1 : 1;
        if (a[1] !== b[1]) return String(a[1]) < String(b[1]) ? -1 : 1;
        return 0;
      }),
  );
}

async function fingerprintOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

async function groupRow(conn: Conn, group: number): Promise<Row> {
  const rows = await conn.query(
    'SELECT id, parent, depth FROM state_groups WHERE id = ?',
    [group],
  );
  if (rows.length === 0) throw new Error(`unknown state group ${group}`);
  return rows[0];
}

async function insertGroup(
  conn: Conn,
  parent: number | null,
  depth: number,
  fingerprint: string,
  entries: readonly StateChange[],
): Promise<number> {
  const existing = await conn.query(
    'SELECT id FROM state_groups WHERE fingerprint = ?',
    [fingerprint],
  );
  if (existing.length > 0) return Number(existing[0].id);
  const inserted = await conn.query(
    'INSERT INTO state_groups(parent, depth, fingerprint) VALUES(?,?,?) RETURNING id',
    [parent, depth, fingerprint],
  );
  const id = Number(inserted[0].id);
  for (const entry of entries) {
    await conn.execute(
      'INSERT INTO state_entries(grp, type, state_key, event) VALUES(?,?,?,?)',
      [id, entry.type, entry.state_key, entry.event],
    );
  }
  return id;
}

export async function newGroup(
  conn: Conn,
  parent: number | null,
  changes: readonly StateChange[],
): Promise<number> {
  // One change per key; the last write in the batch wins.
  const deduped = new Map<string, StateChange>();
  for (const change of changes) {
    deduped.set(change.type + '\0' + change.state_key, change);
  }
  const batch = [...deduped.values()];
  if (parent === null) {
    // A base snapshot; removals have no meaning on an empty map.
    const entries = batch.filter((change) => change.event !== null);
    return await insertGroup(
      conn,
      null,
      0,
      'S:' + await fingerprintOf(canonical(entries)),
      entries,
    );
  }
  if (batch.length === 0) return parent;
  const base = await groupRow(conn, parent);
  if (Number(base.depth) + 1 > SNAPSHOT_DEPTH) {
    // The chain would exceed the bound: flatten into a fresh snapshot.
    const map = new Map<string, StateChange>();
    for (const entry of await groupEntries(conn, parent)) {
      if (entry.event !== null) {
        map.set(entry.type + '\0' + entry.state_key, entry);
      }
    }
    for (const change of batch) {
      if (change.event === null) {
        map.delete(change.type + '\0' + change.state_key);
      } else {
        map.set(change.type + '\0' + change.state_key, change);
      }
    }
    const entries = [...map.values()];
    return await insertGroup(
      conn,
      null,
      0,
      'S:' + await fingerprintOf(canonical(entries)),
      entries,
    );
  }
  const fingerprint = 'D:' + parent + ':' +
    await fingerprintOf(canonical(batch));
  return await insertGroup(
    conn,
    parent,
    Number(base.depth) + 1,
    fingerprint,
    batch,
  );
}

export type Provenance = 'dag' | 'imported' | 'none';

// Event-state refs (R5): `none` keeps both refs NULL (never a fake
// snapshot); refs are set once genuinely known and may move from `none` to
// a real group on placeholder recovery — but never between real groups.
export async function setEventState(
  conn: Conn,
  event: string,
  before: number | null,
  after: number | null,
  provenance: Provenance,
): Promise<void> {
  if ((before === null) !== (after === null)) {
    throw new TypeError('before and after groups are set together');
  }
  if ((before === null) !== (provenance === 'none')) {
    throw new TypeError('provenance none requires NULL groups and vice versa');
  }
  await conn.execute(
    `INSERT INTO event_state(event, before_group, after_group, provenance) VALUES(?,?,?,?)
     ON CONFLICT(event) DO UPDATE SET before_group = excluded.before_group,
       after_group = excluded.after_group, provenance = excluded.provenance`,
    [event, before, after, provenance],
  );
}

// Publication (R6): record the published current state for the stay at a
// change position — only when it changed. Returns whether it recorded.
export async function publish(
  conn: Conn,
  changePos: number,
  stay: number,
  group: number,
): Promise<boolean> {
  const latest = await conn.query(
    'SELECT grp FROM publications WHERE stay = ? ORDER BY change_pos DESC LIMIT 1',
    [stay],
  );
  let previous: number | null = null;
  if (latest.length > 0) {
    previous = Number(latest[0].grp);
    if (Number(latest[0].grp) === group) return false;
  } else {
    const opening = await conn.query(
      'SELECT opening_group FROM segments WHERE id = ?',
      [stay],
    );
    if (opening.length > 0 && opening[0].opening_group !== null) {
      previous = Number(opening[0].opening_group);
    }
    if (
      opening.length > 0 && opening[0].opening_group !== null &&
      Number(opening[0].opening_group) === group
    ) {
      return false;
    }
  }
  await conn.execute(
    'INSERT INTO publications(stay, change_pos, grp) VALUES(?,?,?)',
    [stay, changePos, group],
  );
  // Ordinary single-state writes inspect only their new delta. Resolution,
  // imported state and flattened snapshots compare the two state maps once.
  const row = await groupRow(conn, group);
  let entries: StateChange[];
  if (previous !== null && row.parent === previous) {
    const delta = await conn.query(
      'SELECT type,state_key,event FROM state_entries WHERE grp=?',
      [group],
    );
    entries = [];
    for (const entry of delta) {
      const type = String(entry.type), state_key = String(entry.state_key);
      const event = entry.event === null ? null : String(entry.event);
      if (await groupKey(conn, previous, type, state_key) !== event) {
        entries.push({ type, state_key, event });
      }
    }
  } else {
    const old = new Map(
      (previous === null ? [] : await groupEntries(conn, previous)).map(
        (e) => [e.type + '\0' + e.state_key, e],
      ),
    );
    entries = [];
    for (const entry of await groupEntries(conn, group)) {
      const key = entry.type + '\0' + entry.state_key;
      if (old.get(key)?.event !== entry.event) entries.push(entry);
      old.delete(key);
    }
    entries.push(...[...old.values()].map((e) => ({ ...e, event: null })));
  }
  for (const entry of entries) {
    const sender = entry.event === null
      ? []
      : await conn.query('SELECT sender FROM events WHERE id=?', [entry.event]);
    await conn.execute(
      'INSERT INTO publication_keys(type,state_key,change_pos,event,sender) VALUES(?,?,?,?,?)',
      [
        entry.type,
        entry.state_key,
        changePos,
        entry.event,
        sender[0]?.sender ?? null,
      ],
    );
  }
  return true;
}

// The current-state pointer of a stay (R7): set after a publish, or to the
// opening group when a stay opens.
export async function setCurrent(
  conn: Conn,
  stay: number,
  group: number,
): Promise<void> {
  const updated = await conn.execute(
    'UPDATE segments SET current_group = ? WHERE id = ?',
    [group, stay],
  );
  if (updated === 0) throw new Error(`unknown stay ${stay}`);
}
