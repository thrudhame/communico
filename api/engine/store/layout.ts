// api/engine/store/layout.ts — directory layout, file names and Turso's
// extension-derived sidecars, and each file's recorded owner id. This is the
// sole place that spells sidecar names; all users share the result.
import { join } from '@std/path';
import type { Row } from '#engine/store/ffi.ts';

export function databaseFiles(
  directory: string,
): { database: string; log: string; wal: string } {
  const stem = join(directory, 'data');
  return {
    database: stem + '.db',
    log: stem + '.db-log',
    wal: stem + '.db-wal',
  };
}

export type FileKind = 'rooms' | 'tenants';

export async function keyFor(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(id),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

export function directory(root: string, kind: FileKind, key: string): string {
  return join(root, kind, key);
}

export function serverDirectory(root: string): string {
  return join(root, 'server');
}

// Every room/tenant file records the full id it belongs to in one row; an
// opener must find exactly that id before the file serves anything.
export const ID_SCHEMA = 'CREATE TABLE id(value TEXT PRIMARY KEY NOT NULL)';

export async function recordId(
  db: {
    exec(sql: string): Promise<void>;
    execute(sql: string, values: readonly (string | number)[]): Promise<number>;
  },
  id: string,
): Promise<void> {
  await db.exec(ID_SCHEMA);
  await db.execute('INSERT INTO id VALUES(?)', [id]);
}

export async function checkId(
  db: { query(sql: string): Promise<Row[]> },
  id: string,
): Promise<void> {
  const rows = await db.query('SELECT value FROM id');
  if (rows.length !== 1 || rows[0].value !== id) {
    throw new Error(
      `database id mismatch: expected ${JSON.stringify(id)}, found ${
        JSON.stringify(rows.map((row) => row.value))
      }`,
    );
  }
}
