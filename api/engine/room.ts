import { ident, serverDb, withDb } from './db.ts';
import { author, ingestEvent } from './ingest.ts';
import { getRulebook } from './policy.ts';
import type { EventIndexRow } from './event-format.ts';

async function sha256hex(s: string): Promise<string> {
  const data = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function dbNameFor(roomId: string): Promise<string> {
  return 'room_' + (await sha256hex(roomId)).slice(0, 20);
}

// Runs a .sql file statement-by-statement (split on ';' at line ends —
// the schema files contain no function bodies, so naive splitting is safe).
export async function runSqlFile(c: unknown, path: string): Promise<void> {
  const text = await Deno.readTextFile(path);
  const statements = text
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // deno-lint-ignore no-explicit-any
  const client = c as any;
  for (const stmt of statements) {
    await client.query(stmt);
  }
}

export interface CreateRoomResult {
  createEventId: string;
  memberEventId: string;
}

// v11 genesis (F0): m.room.create (content.room_version, NO creator),
// creator m.room.member join, m.room.power_levels, m.room.join_rules
// {invite} — each through author()+ingest (signed, validated, resolved).
// roomVersion must be a known string ('11'); unknown -> never a default.
export async function createRoom(
  roomId: string,
  roomVersion: string,
  creator: string,
): Promise<CreateRoomResult> {
  getRulebook(roomVersion);
  const dbName = await dbNameFor(roomId);
  await withDb(serverDb(), async (c) => {
    await c.query(`CREATE DATABASE ${ident(dbName)};`);
    await c.query(
      'INSERT INTO room_directory (room_id, db_name, room_version, stub_era) VALUES ($1, $2, $3, FALSE);',
      [roomId, dbName, roomVersion],
    );
  });
  await withDb(dbName, async (c) => {
    await runSqlFile(c, 'db/room/schema.sql');
    await c.query(`SELECT DOLT_COMMIT('-Am', 'room genesis: schema');`);
  });
  const createPdu = await author(roomId, {
    type: 'm.room.create',
    state_key: '',
    sender: creator,
    content: { room_version: roomVersion },
    prev_events: [],
    origin_server_ts: Date.now(),
  });
  const createRes = await ingestEvent(roomId, createPdu);
  // creator's join — through the normal pipeline (the v11 creator-join
  // exemption covers it: sole prev is the create event)
  const memberPdu = await author(roomId, {
    type: 'm.room.member',
    state_key: creator,
    sender: creator,
    content: { membership: 'join' },
    origin_server_ts: Date.now(),
  });
  const memberRes = await ingestEvent(roomId, memberPdu);
  const plPdu = await author(roomId, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: creator,
    content: {
      users: { [creator]: 100 },
      users_default: 0,
      events_default: 0,
      state_default: 50,
      invite: 100,
      kick: 100,
      ban: 100,
      redact: 100,
    },
    origin_server_ts: Date.now(),
  });
  await ingestEvent(roomId, plPdu);
  const jrPdu = await author(roomId, {
    type: 'm.room.join_rules',
    state_key: '',
    sender: creator,
    content: { join_rule: 'invite' },
    origin_server_ts: Date.now(),
  });
  await ingestEvent(roomId, jrPdu);
  return {
    createEventId: createRes.event_id,
    memberEventId: memberRes.event_id,
  };
}

export interface RoomInfo {
  dbName: string;
  roomVersion: string;
  // TRUE only for pre-M3 rooms (dev DBs are reset; no migration — plan §3f).
  stubEra: boolean;
}

export async function lookupRoom(roomId: string): Promise<RoomInfo | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT db_name, room_version, stub_era FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    if (r.rows.length === 0) return null;
    return {
      dbName: r.rows[0].db_name,
      roomVersion: r.rows[0].room_version,
      stubEra: Boolean(r.rows[0].stub_era),
    };
  });
}

// Extremities are only x* branches (main is never an extremity). Returns
// the tip EVENT id + branch per live extremity (event_index.branch_name
// join; stale rows are excluded by joining against live dolt.branches).
// Soft-failed events (M3, S8 check 6) are excluded — they are not added
// to the server's list of forward extremities (server-server-api.md
// 611-614); they still participate in resolution when referenced.
export interface Extremity {
  eventId: string;
  branch: string;
}

export async function extremities(
  dbName: string,
  roomId: string,
): Promise<Extremity[]> {
  return await withDb(dbName, async (c) => {
    const r = await c.query('SELECT name FROM dolt.branches;');
    // deno-lint-ignore no-explicit-any
    const xbranches = r.rows.map((row: any) => String(row.name)).filter(
      (n: string) => n.startsWith('x'),
    );
    if (xbranches.length === 0) return [];
    return await withDb(serverDb(), async (s) => {
      const idx = await s.query(
        'SELECT event_id, branch_name FROM event_index WHERE room_id = $1 AND branch_name = ANY($2) AND rejected = FALSE AND soft_failed = FALSE;',
        [roomId, xbranches],
      );
      // deno-lint-ignore no-explicit-any
      return idx.rows.map((row: any) => ({
        eventId: String(row.event_id),
        branch: String(row.branch_name),
      }));
    });
  });
}

// The extremity whose history a reader follows mid-fork (the documented
// "one side's history" simplification). Deterministic and content-based:
// greatest tip depth, tie → smallest event_id. Never a soft-failed or
// rejected tip (extremities() excludes them). Current STATE is never read
// this way — it lives on main (materialize.publishCurrentState).
export async function headExtremity(
  dbName: string,
  roomId: string,
): Promise<Extremity | null> {
  const xbs = await extremities(dbName, roomId);
  if (xbs.length === 0) return null;
  const withDepth = await withDb(dbName, async (c) => {
    const out: (Extremity & { depth: number })[] = [];
    for (const xb of xbs) {
      const r = await c.query(
        `SELECT depth FROM events AS OF '${
          ident(xb.branch)
        }' WHERE event_id = $1;`,
        [xb.eventId],
      );
      out.push({ ...xb, depth: Number(r.rows[0]?.depth ?? 0) });
    }
    return out;
  });
  withDepth.sort((a, b) =>
    b.depth - a.depth || (a.eventId < b.eventId ? -1 : 1)
  );
  return withDepth[0];
}

// --- M4: state-at-position primitives (E1/E2, plan §3b) -------------------

export interface StateRow {
  type: string;
  stateKey: string;
  eventId: string;
  content: unknown;
}

// The state_commit_hash of the last non-rejected, non-soft-failed R-event
// with seq <= the given one; seq === null -> HASHOF('main') (now). null
// when no such event exists (before the room's first event).
export async function stateCommitAtSeq(
  roomId: string,
  seq: number | null,
): Promise<string | null> {
  if (seq === null) {
    const room = await lookupRoom(roomId);
    if (!room) return null;
    return await withDb(room.dbName, async (c) => {
      const r = await c.query(`SELECT HASHOF('main') AS h;`);
      return String(r.rows[0].h);
    });
  }
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT state_commit_hash FROM event_index
       WHERE room_id = $1 AND seq <= $2 AND rejected = FALSE AND soft_failed = FALSE
         AND state_commit_hash IS NOT NULL
       ORDER BY seq DESC LIMIT 1;`,
      [roomId, seq],
    );
    return r.rows.length ? String(r.rows[0].state_commit_hash) : null;
  });
}

// The room's state AS OF a `main` commit hash (E1: `main`'s commit history
// IS the state history).
export async function stateAt(
  dbName: string,
  stateHash: string,
): Promise<StateRow[]> {
  if (!/^[a-z0-9]+$/i.test(stateHash)) {
    throw new Error('E_BAD_HASH: ' + stateHash);
  }
  return await withDb(dbName, async (c) => {
    const r = await c.query(
      `SELECT type, state_key, event_id, content FROM state AS OF '${stateHash}';`,
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      type: String(row.type),
      stateKey: String(row.state_key),
      eventId: String(row.event_id),
      content: typeof row.content === 'string'
        ? JSON.parse(row.content)
        : row.content,
    }));
  });
}

// stateAt at a seq position (null = now); null when the position precedes
// the room's first event.
export async function stateAtSeq(
  roomId: string,
  seq: number | null,
): Promise<StateRow[] | null> {
  const hash = await stateCommitAtSeq(roomId, seq);
  if (hash === null) return null;
  const room = await lookupRoom(roomId);
  if (!room) return null;
  return await stateAt(room.dbName, hash);
}

// The user's CURRENT membership row in the room (from the room_membership
// index — the row exists for any membership value, incl. leave/ban).
export async function membershipOf(
  roomId: string,
  userId: string,
): Promise<{ membership: string; eventId: string; seq: number } | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT membership, event_id, seq FROM room_membership WHERE room_id = $1 AND user_id = $2;',
      [roomId, userId],
    );
    return r.rows.length
      ? {
        membership: String(r.rows[0].membership),
        eventId: String(r.rows[0].event_id),
        seq: Number(r.rows[0].seq),
      }
      : null;
  });
}

// Every room the user has a membership row in, any value.
export async function roomsFor(
  userId: string,
): Promise<{ roomId: string; membership: string; seq: number }[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id, membership, seq FROM room_membership WHERE user_id = $1;',
      [userId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => ({
      roomId: String(row.room_id),
      membership: String(row.membership),
      seq: Number(row.seq),
    }));
  });
}

// Just the room ids the user is currently joined to.
export async function joinedRooms(userId: string): Promise<string[]> {
  return (await roomsFor(userId))
    .filter((r) => r.membership === 'join')
    .map((r) => r.roomId);
}

// --- M4: aliases + stream tokens -----------------------------------------

// alias -> room id (createRoom room_alias_name; /join by alias).
export async function lookupAlias(alias: string): Promise<string | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT room_id FROM room_aliases WHERE alias = $1;',
      [alias],
    );
    return r.rows.length ? String(r.rows[0].room_id) : null;
  });
}

// The full event_index row for one event (the formatter's input shape).
export async function eventIndexRow(
  roomId: string,
  eventId: string,
): Promise<EventIndexRow | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT * FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return null;
    const row = r.rows[0];
    return {
      event_id: String(row.event_id),
      room_id: String(row.room_id),
      commit_hash: String(row.commit_hash),
      rejected: row.rejected === true,
      soft_failed: row.soft_failed === true,
      seq: Number(row.seq),
      state_commit_hash: row.state_commit_hash == null
        ? null
        : String(row.state_commit_hash),
      redacted_by: row.redacted_by == null ? null : String(row.redacted_by),
      txn_device: row.txn_device == null ? null : String(row.txn_device),
      txn_id: row.txn_id == null ? null : String(row.txn_id),
    };
  });
}

// E3: sync token grammar — s<eventSeq>_p<presenceSeq>; legacy s<n> parses
// as _p0. Tokens are global stream positions: valid across users, and as
// /messages?from=/to= and /members?at=.
export function parseStreamToken(
  raw: string | null,
): { eSeq: number; pSeq: number } | null {
  if (raw === null) return null;
  const m = /^s(\d+)(?:_p(\d+))?$/.exec(raw);
  if (!m) return null;
  return { eSeq: Number(m[1]), pSeq: m[2] ? Number(m[2]) : 0 };
}

export function formatStreamToken(eSeq: number, pSeq: number): string {
  return `s${eSeq}_p${pSeq}`;
}
