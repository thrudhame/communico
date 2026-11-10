// api/engine/room/state.ts — readers over state groups, event-state refs,
// publications and the current pointer. No writes here (R7): state_groups,
// state_entries, event_state, publications and the current pointer belong
// to materialize.ts alone.
import type { Conn } from '#engine/store/db.ts';
import { childrenOf, prevsOf } from './events.ts';
import { precedes } from './causal.ts';

export type StateChange = {
  type: string;
  state_key: string;
  event: string | null; // NULL removes the key (delta only)
};

export type StateMap = Map<string, string>; // type + '\0' + state_key → event id

// A state map as a change batch (a base snapshot's entries).
export function mapEntries(map: StateMap): StateChange[] {
  const out: StateChange[] = [];
  for (const [k, event] of map) {
    const sep = k.indexOf('\0');
    out.push({
      type: k.slice(0, sep),
      state_key: k.slice(sep + 1),
      event,
    });
  }
  return out;
}

// The full map of a group as entries: the nearest snapshot plus every
// delta down to the group, oldest first; a delta's NULL event removes.
export async function groupEntries(
  conn: Conn,
  group: number,
): Promise<StateChange[]> {
  const chain: { id: number; parent: number | null }[] = [];
  let cursor: number | null = group;
  while (cursor !== null) {
    const rows = await conn.query(
      'SELECT id, parent FROM state_groups WHERE id = ?',
      [cursor],
    );
    if (rows.length === 0) throw new Error(`unknown state group ${group}`);
    chain.push({
      id: Number(rows[0].id),
      parent: rows[0].parent === null ? null : Number(rows[0].parent),
    });
    cursor = rows[0].parent === null ? null : Number(rows[0].parent);
  }
  const map = new Map<string, StateChange>();
  for (let index = chain.length - 1; index >= 0; index--) {
    const entries = await conn.query(
      'SELECT type, state_key, event FROM state_entries WHERE grp = ?',
      [chain[index].id],
    );
    for (const entry of entries) {
      const key = String(entry.type) + '\0' + String(entry.state_key);
      if (entry.event === null) map.delete(key);
      else {
        map.set(key, {
          type: String(entry.type),
          state_key: String(entry.state_key),
          event: String(entry.event),
        });
      }
    }
  }
  return [...map.values()];
}

export async function groupMap(conn: Conn, group: number): Promise<StateMap> {
  const map: StateMap = new Map();
  for (const entry of await groupEntries(conn, group)) {
    if (entry.event !== null) {
      map.set(entry.type + '\0' + entry.state_key, entry.event);
    }
  }
  return map;
}

// Selected-key read: walk ≤ 32 deltas to the nearest snapshot, looking at
// each level's entry for the key (NULL = removed).
export async function groupKey(
  conn: Conn,
  group: number,
  type: string,
  stateKey: string,
): Promise<string | null> {
  let cursor: number | null = group;
  while (cursor !== null) {
    const rows = await conn.query(
      'SELECT parent FROM state_groups WHERE id = ?',
      [cursor],
    );
    if (rows.length === 0) throw new Error(`unknown state group ${group}`);
    const hit = await conn.query(
      'SELECT event FROM state_entries WHERE grp = ? AND type = ? AND state_key = ?',
      [cursor, type, stateKey],
    );
    if (hit.length > 0) {
      return hit[0].event === null ? null : String(hit[0].event);
    }
    cursor = rows[0].parent === null ? null : Number(rows[0].parent);
  }
  return null;
}

export type EventStateRef = {
  group: number;
  provenance: 'dag' | 'imported';
};

async function eventStateRef(
  conn: Conn,
  event: string,
  column: 'before_group' | 'after_group',
): Promise<EventStateRef | null> {
  const rows = await conn.query(
    `SELECT ${column} AS grp, provenance FROM event_state WHERE event = ?`,
    [event],
  );
  if (rows.length === 0 || rows[0].grp === null) return null;
  return {
    group: Number(rows[0].grp),
    provenance: String(rows[0].provenance) as 'dag' | 'imported',
  };
}

export function eventStateBefore(
  conn: Conn,
  event: string,
): Promise<EventStateRef | null> {
  return eventStateRef(conn, event, 'before_group');
}

export function eventStateAfter(
  conn: Conn,
  event: string,
): Promise<EventStateRef | null> {
  return eventStateRef(conn, event, 'after_group');
}

// The read contract for "state at an event" (G6): the event's OWN
// stored refs, never the room's current state as a fallback. NULL when
// the state is genuinely unknown (evidence/pending) — never a fake.
export async function eventReadState(
  conn: Conn,
  event: string,
): Promise<{ before: EventStateRef; after: EventStateRef } | null> {
  const before = await eventStateBefore(conn, event);
  const after = await eventStateAfter(conn, event);
  if (before === null || after === null) return null;
  return { before, after };
}

// State at live position N: the latest publication ≤ N in the stay, or the
// stay's opening group when nothing was published yet (a new stay's state).
export async function publishedAt(
  conn: Conn,
  stay: number,
  pos: number,
): Promise<number | null> {
  const rows = await conn.query(
    'SELECT grp FROM publications WHERE stay = ? AND change_pos <= ? ORDER BY change_pos DESC LIMIT 1',
    [stay, pos],
  );
  if (rows.length > 0) return Number(rows[0].grp);
  const opening = await conn.query(
    'SELECT opening_group FROM segments WHERE id = ?',
    [stay],
  );
  if (opening.length === 0 || opening[0].opening_group === null) return null;
  return Number(opening[0].opening_group);
}

// The stay's current published state: the pointer materialize moved, or
// the opening group before the first publication.
export async function current(
  conn: Conn,
  stay: number,
): Promise<number | null> {
  const rows = await conn.query(
    'SELECT opening_group, current_group FROM segments WHERE id = ?',
    [stay],
  );
  if (rows.length === 0) return null;
  if (rows[0].current_group !== null) return Number(rows[0].current_group);
  return rows[0].opening_group === null ? null : Number(rows[0].opening_group);
}

// Published snapshots at/after a positioned event in the stable book. History
// precedes its owning stay, regardless of its later insertion/change position.
// Opening snapshots cover imported members with no positioned membership event.
export async function publishedGroupsAfter(
  conn: Conn,
  event: string,
): Promise<number[]> {
  const isolated = await conn.query(
    `SELECT p.event FROM positions p JOIN segments s ON s.id = p.segment
     WHERE p.event = ? AND s.kind = 'anchor'`,
    [event],
  );
  if (isolated.length > 0) {
    // Ownership only says where bytes were acquired. An isolated anchor can
    // lie after any publication in that stay; only actual DAG evidence proves
    // a later live cut. Imported opening groups need their real opener too.
    const snapshots = await conn.query(
      `SELECT pub.grp, c.event FROM publications pub JOIN changes c ON c.pos = pub.change_pos
       UNION SELECT opening_group AS grp, opened_by AS event FROM segments
       WHERE kind = 'stay' AND opening_group IS NOT NULL AND opened_by IS NOT NULL`,
    );
    const groups = new Set<number>();
    const budget = { remaining: 100_000 };
    const graph = {
      prevsOf: (id: string) => prevsOf(conn, id),
      childrenOf: (id: string) => childrenOf(conn, id),
    };
    for (const row of snapshots) {
      if (
        row.event !== null &&
        await precedes(graph, event, String(row.event), budget) === true
      ) {
        groups.add(Number(row.grp));
      }
    }
    return [...groups];
  }
  const rows = await conn.query(
    `WITH anchor AS (
       SELECT CASE WHEN s.kind = 'history' THEN s.prev ELSE s.id END AS stay,
              s.kind, p.offset
       FROM positions p JOIN segments s ON s.id = p.segment WHERE p.event = ?
     )
     SELECT pub.grp FROM publications pub
       JOIN changes c ON c.pos = pub.change_pos
       JOIN positions p ON p.event = c.event CROSS JOIN anchor a
     WHERE pub.stay > a.stay OR (pub.stay = a.stay AND
         (a.kind = 'history' OR p.offset >= a.offset))
     UNION
     SELECT s.opening_group AS grp FROM segments s CROSS JOIN anchor a
     WHERE s.kind = 'stay' AND s.opening_group IS NOT NULL AND
         (s.id > a.stay OR (s.id = a.stay AND a.kind = 'history'))`,
    [event],
  );
  return rows.map((row) => Number(row.grp));
}
