// api/engine/server/read.ts — the query functions the later stages
// compose: the feed window, the per-user memberships, event → room, the
// due outbox, the relations index and the search candidates with the old
// matching behaviour (D2: matching in JS, the SQL only scopes). Old
// evidence: syncfeed.ts's window query and roomsFor/membershipOf
// (room.ts), relations.ts's relationRows, search.ts's candidates +
// matchTokens/rankOf, federation/outbox.ts's eventBatchFor.
import type { Db } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';

// --- the feed --------------------------------------------------------------

export type FeedRow = {
  seq: number;
  room: string;
  pos: number;
  event: string;
  stay: number;
};

function feedRowOf(row: Row): FeedRow {
  return {
    seq: Number(row.seq),
    room: String(row.room),
    pos: Number(row.pos),
    event: String(row.event),
    stay: Number(row.stay),
  };
}

// One room's live window after a stream position, oldest first (the old
// roomTimeline raw window). Every feed row is an accepted live event —
// the room positions no other, so the old rejected/soft_failed read-time
// filter has no rows to remove here.
export async function feedAfter(
  db: Db,
  roomId: string,
  sinceSeq: number,
  limit: number,
): Promise<FeedRow[]> {
  const rows = await db.query(
    `SELECT seq, room, pos, event, stay FROM feed
     WHERE room = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
    [roomId, sinceSeq, limit],
  );
  return rows.map(feedRowOf);
}

// The global stream maximum (the old MAX(seq) — next_batch's event part).
export async function feedMax(db: Db): Promise<number> {
  const rows = await db.query('SELECT MAX(seq) AS m FROM feed');
  return rows[0].m === null ? 0 : Number(rows[0].m);
}

// --- memberships -----------------------------------------------------------

export type MembershipRow = {
  roomId: string;
  membership: string;
  eventId: string;
  seq: number;
  forgotten: boolean;
};

function membershipRowOf(row: Row): MembershipRow {
  return {
    roomId: String(row.room),
    membership: String(row.membership),
    eventId: String(row.event),
    seq: Number(row.seq),
    forgotten: Number(row.forgotten) === 1,
  };
}

const MEMBERSHIP_SELECT =
  `SELECT m.room, m.membership, m.event, m.seq, (f.user IS NOT NULL) AS forgotten
   FROM memberships m
   LEFT JOIN forgotten f ON f.user = m.user AND f.room = m.room`;

// Every room the user has a membership row in, any value (the old
// roomsFor; the forgotten flag rides along, stage 5 decides its read
// semantics — the projection never touches it).
export async function roomsFor(
  db: Db,
  userId: string,
): Promise<MembershipRow[]> {
  const rows = await db.query(`${MEMBERSHIP_SELECT} WHERE m.user = ?`, [
    userId,
  ]);
  return rows.map(membershipRowOf);
}

// The user's membership in one room (the old membershipOf), null when
// there is no row (the reads default that to 'leave', MSC4115).
export async function membershipOf(
  db: Db,
  roomId: string,
  userId: string,
): Promise<MembershipRow | null> {
  const rows = await db.query(
    `${MEMBERSHIP_SELECT} WHERE m.room = ? AND m.user = ?`,
    [roomId, userId],
  );
  return rows.length === 0 ? null : membershipRowOf(rows[0]);
}

// --- event → room ----------------------------------------------------------

export async function roomOf(db: Db, eventId: string): Promise<string | null> {
  const rows = await db.query('SELECT room FROM event_index WHERE event = ?', [
    eventId,
  ]);
  return rows.length === 0 ? null : String(rows[0].room);
}

// --- the outbox ------------------------------------------------------------

export type OutboxDueRow = {
  room: string;
  pos: number;
  destination: string;
  event: string;
  seq: number;
  attempts: number;
  addedMs: number;
};

// The due rows for one destination (state pending, next attempt not in
// the future), oldest first. Send order is the event's feed position —
// the old "insertion order = send order" (the rows were written beside
// the index row in seq order).
export async function outboxDue(
  db: Db,
  destination: string,
  nowMs: number,
  limit: number,
): Promise<OutboxDueRow[]> {
  const rows = await db.query(
    `SELECT o.room, o.pos, o.destination, o.event, o.attempts, o.added_ms, f.seq
     FROM outbox o JOIN feed f ON f.room = o.room AND f.event = o.event
     WHERE o.destination = ? AND o.state = 'pending' AND o.next_attempt_ms <= ?
     ORDER BY f.seq ASC LIMIT ?`,
    [destination, nowMs, limit],
  );
  return rows.map((row) => ({
    room: String(row.room),
    pos: Number(row.pos),
    destination: String(row.destination),
    event: String(row.event),
    seq: Number(row.seq),
    attempts: Number(row.attempts),
    addedMs: Number(row.added_ms),
  }));
}

// --- relations -------------------------------------------------------------

export type RelationRow = {
  eventId: string;
  relType: string | null;
  seq: number;
};

// The children of a parent event, oldest first; relType optional (the
// /relations/{id} vs /relations/{id}/{relType} forms). Event-type
// filtering happens at render time — the index stores no type column
// (the old relationRows).
export async function relationsOf(
  db: Db,
  roomId: string,
  eventId: string,
  relType?: string,
): Promise<RelationRow[]> {
  const rows = relType === undefined
    ? await db.query(
      `SELECT event, rel_type, seq FROM relations
       WHERE room = ? AND relates_to = ? ORDER BY seq ASC`,
      [roomId, eventId],
    )
    : await db.query(
      `SELECT event, rel_type, seq FROM relations
       WHERE room = ? AND relates_to = ? AND rel_type = ? ORDER BY seq ASC`,
      [roomId, eventId, relType],
    );
  return rows.map((row) => ({
    eventId: String(row.event),
    relType: row.rel_type === null ? null : String(row.rel_type),
    seq: Number(row.seq),
  }));
}

// --- search ----------------------------------------------------------------

export const SEARCH_KEYS = ['content.body', 'content.name', 'content.topic'];

export type SearchCandidate = {
  eventId: string;
  roomId: string;
  seq: number;
  sender: string;
  bodyLower: string;
};

// The candidates of a room set and keys, newest first, redacted targets
// excluded (the old redacted_by read-time filter — the stored PDU stays
// verbatim, the effect applies at read). Matching and ranking are the
// caller's JS over bodyLower, exactly the old split.
export async function searchCandidates(
  db: Db,
  rooms: readonly string[],
  keys: readonly string[],
): Promise<SearchCandidate[]> {
  if (rooms.length === 0 || keys.length === 0) return [];
  const marks = (values: readonly string[]) => values.map(() => '?').join(',');
  const rows = await db.query(
    `SELECT s.event, s.room, s.seq, s.sender, s.body_lower
     FROM search s
     WHERE s.room IN (${marks(rooms)}) AND s.key IN (${marks(keys)})
       AND s.event NOT IN (SELECT target FROM redactions)
     ORDER BY s.seq DESC`,
    [...rooms, ...keys],
  );
  return rows.map((row) => ({
    eventId: String(row.event),
    roomId: String(row.room),
    seq: Number(row.seq),
    sender: String(row.sender),
    bodyLower: String(row.body_lower),
  }));
}

// The old matching behaviour (search.ts): every token must appear.
export function matchTokens(bodyLower: string, tokens: string[]): boolean {
  return tokens.every((t) => bodyLower.includes(t));
}

// The old rank: total token occurrences per indexed word.
export function rankOf(bodyLower: string, tokens: string[]): number {
  const words = bodyLower.split(/\s+/).filter(Boolean);
  if (words.length === 0) return 0;
  let occ = 0;
  for (const t of tokens) occ += countSubstr(bodyLower, t);
  return occ / words.length;
}

function countSubstr(hay: string, needle: string): number {
  if (needle === '') return 0;
  let n = 0;
  let i = 0;
  for (;;) {
    const j = hay.indexOf(needle, i);
    if (j < 0) break;
    n++;
    i = j + needle.length;
  }
  return n;
}
