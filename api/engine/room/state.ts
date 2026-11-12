// api/engine/room/state.ts — readers over state groups, event-state refs,
// publications and the current pointer. No writes here (R7): state_groups,
// state_entries, event_state, publications and the current pointer belong
// to materialize.ts alone.
import type { Conn } from '#engine/store/db.ts';
import { childrenOf } from './events.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export type ErasureCut = { changePos: number; segment: number; group: number };

export async function erasureCut(conn: Conn): Promise<ErasureCut> {
  const rows = await conn.query(
    'SELECT (SELECT COALESCE(MAX(pos),0) FROM changes) AS change_pos,(SELECT COALESCE(MAX(id),0) FROM segments) AS segment,(SELECT COALESCE(MAX(id),0) FROM state_groups) AS grp',
  );
  return {
    changePos: Number(rows[0].change_pos),
    segment: Number(rows[0].segment),
    group: Number(rows[0].grp),
  };
}

export type StateChange = {
  type: string;
  state_key: string;
  event: string | null; // NULL removes the key (delta only)
};

export type StateMap = Map<string, string>; // type + '\0' + state_key → event id

// Follow actual publications, including resolved/imported state, rather than
// treating every arriving state PDU as a change to current room state.
export async function changedByOther(
  conn: Conn,
  type: string,
  stateKey: string,
  sender: string,
  after: number,
  initial: string | null,
): Promise<boolean> {
  let cursor = after, previous = initial;
  while (true) {
    const page = await conn.query(
      'SELECT change_pos,grp FROM publications WHERE change_pos>? ORDER BY change_pos LIMIT 32',
      [cursor],
    );
    for (const row of page) {
      cursor = Number(row.change_pos);
      const id = await groupKey(conn, Number(row.grp), type, stateKey);
      if (id === previous) continue;
      previous = id;
      if (id !== null) {
        const event = await conn.query('SELECT sender FROM events WHERE id=?', [
          id,
        ]);
        if (event.length && event[0].sender !== sender) return true;
      }
    }
    if (page.length < 32) return false;
  }
}

// Published participation, not a current invite/leave row, proves shared history.
export async function hasJoinedBefore(
  conn: Conn,
  userId: string,
  changePos: number,
): Promise<boolean> {
  const groups = await conn.query(
    `SELECT DISTINCT p.grp FROM events e
     JOIN changes c ON c.event=e.id AND c.kind IN ('event','transition')
     JOIN publications p ON p.change_pos=c.pos
     WHERE e.type='m.room.member' AND e.state_key=?
       AND json_extract(e.pdu,'$.content.membership')='join' AND c.pos<=?`,
    [userId, changePos],
  );
  for (const row of groups) {
    const event = await groupKey(
      conn,
      Number(row.grp),
      'm.room.member',
      userId,
    );
    if (event === null) continue;
    const membership = await conn.query('SELECT pdu FROM events WHERE id=?', [
      event,
    ]);
    if (
      membership.length &&
      JSON.parse(String(membership[0].pdu)).content?.membership === 'join'
    ) return true;
  }
  return false;
}

// Find the most recent published participation interval at a room change cut.
// A later ban/reinvitation/decline cannot move the real departure boundary.
export async function participationAt(
  conn: Conn,
  userId: string,
  through: number,
  stay: number,
) {
  let cursor = through;
  let cursorStay = stay;
  let inclusive = true;
  let departure: { pos: number; stay: number; group: number } | null = null;
  while (cursor >= 0) {
    const page = await conn.query(
      `SELECT change_pos,stay,grp FROM publications WHERE stay<=? AND change_pos${
        inclusive ? '<=' : '<'
      }? ORDER BY stay DESC,change_pos DESC LIMIT 32`,
      [cursorStay, cursor],
    );
    const cache = new Map<number, string>();
    for (const row of page) {
      const pos = Number(row.change_pos), group = Number(row.grp);
      cursor = pos;
      cursorStay = Number(row.stay);
      if (!cache.has(group)) {
        const id = await groupKey(conn, group, 'm.room.member', userId);
        const pdu = id === null
          ? []
          : await conn.query('SELECT pdu FROM events WHERE id=?', [id]);
        cache.set(
          group,
          pdu.length
            ? String(JSON.parse(String(pdu[0].pdu)).content?.membership)
            : 'leave',
        );
      }
      if (cache.get(group) === 'join') return { joined: pos, departure };
      departure = { pos, stay: Number(row.stay), group };
    }
    if (page.length < 32) break;
    inclusive = false;
  }
  return null;
}

// Did published participation stop between two room change cuts? Event-DAG
// membership alone cannot answer this across resolved/imported publications.
export async function membershipInterrupted(
  conn: Conn,
  userId: string,
  after: number,
  through: number,
): Promise<boolean> {
  let cursor = after;
  const seen = new Set<number>();
  while (cursor < through) {
    seen.clear();
    const page = await conn.query(
      'SELECT change_pos,grp FROM publications WHERE change_pos>? AND change_pos<=? ORDER BY change_pos LIMIT 32',
      [cursor, through],
    );
    if (!page.length) break;
    for (const row of page) {
      cursor = Number(row.change_pos);
      const group = Number(row.grp);
      if (seen.has(group)) continue;
      seen.add(group);
      const id = await groupKey(conn, group, 'm.room.member', userId);
      if (id === null) return true;
      const event = await conn.query('SELECT pdu FROM events WHERE id=?', [id]);
      if (
        !event.length ||
        JSON.parse(String(event[0].pdu)).content?.membership !== 'join'
      ) return true;
    }
    if (page.length < 32) break;
  }
  return false;
}

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
  cut?: ErasureCut,
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
    // One bounded graph walk, then indexed selection of only proved snapshots.
    // Allocation order cannot establish causal visibility for isolated anchors.
    const seen = new Set([event]);
    const queue = [event];
    let remaining = 100_000;
    const spend = () => {
      if (--remaining < 0) {
        throw new MatrixError(
          503,
          'M_UNKNOWN',
          'publication visibility exceeds bounded history read',
        );
      }
    };
    for (let i = 0; i < queue.length; i++) {
      spend();
      for (const child of await childrenOf(conn, queue[i])) {
        spend();
        if (seen.has(child)) continue;
        seen.add(child);
        queue.push(child);
      }
    }
    const groups = new Set<number>();
    for (let i = 0; i < queue.length; i += 200) {
      const batch = queue.slice(i, i + 200);
      const slots = batch.map(() => '?').join(',');
      const snapshots = await conn.query(
        `SELECT pub.grp FROM changes c JOIN publications pub ON pub.change_pos = c.pos
         WHERE c.event IN (${slots}) AND c.kind IN ('event', 'transition') AND pub.change_pos <= ?
         UNION SELECT opening_group AS grp FROM segments
         WHERE kind = 'stay' AND opening_group IS NOT NULL AND opened_by IN (${slots}) AND id <= ? LIMIT ?`,
        [
          ...batch,
          cut?.changePos ?? Number.MAX_SAFE_INTEGER,
          ...batch,
          cut?.segment ?? Number.MAX_SAFE_INTEGER,
          remaining + 1,
        ],
      );
      for (const row of snapshots) {
        spend();
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
      WHERE pub.change_pos <= ? AND (pub.stay > a.stay OR (pub.stay = a.stay AND
          (a.kind = 'history' OR p.offset >= a.offset)))
     UNION
     SELECT s.opening_group AS grp FROM segments s CROSS JOIN anchor a
      WHERE s.kind = 'stay' AND s.opening_group IS NOT NULL AND s.id <= ? AND
         (s.id > a.stay OR (s.id = a.stay AND a.kind = 'history'))`,
    [
      event,
      cut?.changePos ?? Number.MAX_SAFE_INTEGER,
      cut?.segment ?? Number.MAX_SAFE_INTEGER,
    ],
  );
  return rows.map((row) => Number(row.grp));
}
