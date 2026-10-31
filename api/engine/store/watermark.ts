// api/engine/store/watermark.ts — the server file's roll-forward positions.
// advance() runs inside the caller's own server-file transaction and never
// moves a source's position backward, so replays after a crash are safe.
import type { Conn, Db } from '#engine/store/db.ts';

export const WATERMARK_SCHEMA =
  'CREATE TABLE IF NOT EXISTS watermarks(source TEXT PRIMARY KEY NOT NULL, position INTEGER NOT NULL)';

export async function ensureWatermarks(db: Db): Promise<void> {
  await db.exec(WATERMARK_SCHEMA);
}

export async function get(db: Db, source: string): Promise<number> {
  const rows = await db.query(
    'SELECT position FROM watermarks WHERE source = ?',
    [source],
  );
  if (rows.length === 0) return 0;
  const position = rows[0].position;
  if (typeof position !== 'number') {
    throw new Error(`watermark position is not numeric: ${String(position)}`);
  }
  return position;
}

export async function advance(
  tx: Conn,
  source: string,
  position: number,
): Promise<void> {
  if (!Number.isSafeInteger(position) || position < 0) {
    throw new TypeError(
      'watermark position must be a non-negative safe integer',
    );
  }
  await tx.execute(
    'INSERT INTO watermarks VALUES(?, ?) ON CONFLICT(source) DO UPDATE SET position = excluded.position WHERE excluded.position > watermarks.position',
    [source, position],
  );
}

export async function sources(db: Db): Promise<string[]> {
  const rows = await db.query('SELECT source FROM watermarks ORDER BY source');
  return rows.map((row) => {
    if (typeof row.source !== 'string') {
      throw new Error(`watermark source is not text: ${String(row.source)}`);
    }
    return row.source;
  });
}

// Startup hooks receive the opening store (roll-forward needs the server
// file and the room/tenant files); declared structurally to keep this
// module below the store's public face.
export type StartupStore = {
  server(): Promise<Db>;
  room(id: string, options?: { create?: boolean }): Promise<Db>;
  tenant(id: string, options?: { create?: boolean }): Promise<Db>;
};

const hooks: ((store: StartupStore) => Promise<void>)[] = [];

export function onStartup(fn: (store: StartupStore) => Promise<void>): void {
  hooks.push(fn);
}

export function startupHooks(): readonly ((
  store: StartupStore,
) => Promise<void>)[] {
  return hooks.slice();
}
