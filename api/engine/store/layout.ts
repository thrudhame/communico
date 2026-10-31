// api/engine/store/layout.ts — file names and Turso's extension-derived sidecars.
// This is the sole place that spells sidecar names; all users share the result.
import { join } from '@std/path';

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
