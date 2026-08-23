import { ident, SERVER_DB, withDb } from './db.ts';
import { ingestEvent } from './ingest.ts';

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

export async function createRoom(
  roomId: string,
  roomVersion: string,
  creator: string,
): Promise<void> {
  const dbName = await dbNameFor(roomId);
  await withDb(SERVER_DB, async (c) => {
    await c.query(`CREATE DATABASE ${ident(dbName)};`);
    await c.query(
      'INSERT INTO room_directory (room_id, db_name, room_version) VALUES ($1, $2, $3);',
      [roomId, dbName, roomVersion],
    );
  });
  await withDb(dbName, async (c) => {
    await runSqlFile(c, 'db/room/schema.sql');
    await c.query(`SELECT DOLT_COMMIT('-Am', 'room genesis: schema');`);
  });
  await ingestEvent(roomId, {
    type: 'm.room.create',
    state_key: '',
    sender: creator,
    content: { creator, room_version: roomVersion },
    prev_events: [],
    origin_ts: Date.now(),
  });
}

export interface RoomInfo {
  dbName: string;
  roomVersion: string;
}

export async function lookupRoom(roomId: string): Promise<RoomInfo | null> {
  return await withDb(SERVER_DB, async (c) => {
    const r = await c.query(
      'SELECT db_name, room_version FROM room_directory WHERE room_id = $1;',
      [roomId],
    );
    if (r.rows.length === 0) return null;
    return { dbName: r.rows[0].db_name, roomVersion: r.rows[0].room_version };
  });
}

// Extremities are only x* branches (main is never an extremity).
export async function extremities(dbName: string): Promise<string[]> {
  return await withDb(dbName, async (c) => {
    const r = await c.query('SELECT name FROM dolt.branches;');
    // deno-lint-ignore no-explicit-any
    return r.rows.map((row: any) => String(row.name)).filter((n: string) =>
      n.startsWith('x')
    );
  });
}
