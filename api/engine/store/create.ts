// api/engine/store/create.ts — publish only a closed, reopened, verified and
// fsynced database. Failed creation is deliberately left for startup sweep.
import { basename, join } from '@std/path';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { databaseFiles } from '#engine/store/layout.ts';

export type CreateOptions = {
  checkpointlogbytes: number;
  schema: (db: Db) => Promise<void>;
  verify: (db: Db) => Promise<void>;
  beforeRename?: (temporary: string, final: string) => Promise<void>;
};

async function sync(path: string): Promise<void> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.sync();
  } finally {
    file.close();
  }
}

async function syncTree(directory: string): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isFile) await sync(path);
    else if (entry.isDirectory) await syncTree(path);
    else throw new Error(`unexpected non-regular database entry: ${path}`);
  }
  await sync(directory);
}

export async function integrityCheck(db: Db): Promise<void> {
  const rows = await db.query('PRAGMA integrity_check');
  if (
    rows.length !== 1 || Object.values(rows[0]).length !== 1 ||
    Object.values(rows[0])[0] !== 'ok'
  ) {
    throw new Error(`database integrity check failed: ${JSON.stringify(rows)}`);
  }
}

export async function createDatabase(
  ffi: Turso,
  parent: string,
  name: string,
  options: CreateOptions,
): Promise<string> {
  if (
    name !== basename(name) || name === '.' || name === '..' ||
    name.endsWith('.new')
  ) {
    throw new TypeError('database directory name must be a plain basename');
  }
  const final = join(parent, name);
  const temporary = final + '.new';
  try {
    await Deno.lstat(final);
    throw new Deno.errors.AlreadyExists(
      `database directory already exists: ${final}`,
    );
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  await Deno.mkdir(temporary, { mode: 0o700 });
  const path = databaseFiles(temporary).database;
  let db = await Db.open(ffi, path, options.checkpointlogbytes);
  try {
    await options.schema(db);
  } finally {
    await db.close();
  }
  db = await Db.open(ffi, path, options.checkpointlogbytes);
  try {
    await integrityCheck(db);
    await options.verify(db);
  } finally {
    await db.close();
  }
  await syncTree(temporary);
  await options.beforeRename?.(temporary, final);
  await Deno.rename(temporary, final);
  await sync(parent);
  return final;
}

export async function sweep(parent: string): Promise<string[]> {
  const removed: string[] = [];
  try {
    for await (const entry of Deno.readDir(parent)) {
      if (!entry.isDirectory || !entry.name.endsWith('.new')) continue;
      const path = join(parent, entry.name);
      await Deno.remove(path, { recursive: true });
      removed.push(path);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return removed;
}
