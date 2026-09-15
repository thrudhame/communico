import { ident, serverDb, withDb } from './db.ts';
import { author, ingestEvent } from './ingest.ts';
import { getRulebook } from './policy.ts';

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
