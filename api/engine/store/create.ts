// api/engine/store/create.ts — publish only a closed, reopened, verified and
// fsynced database. Failed creation is deliberately left for startup sweep.
// Schema providers own each database kind's domain tables; the store owns
// the meta table and refuses a missing row or a version mismatch (R14).
import { basename, join } from '@std/path';
import { Db } from '#engine/store/db.ts';
import { type Row, Turso } from '#engine/store/ffi.ts';
import { databaseFiles } from '#engine/store/layout.ts';

export type CreateOptions = {
  checkpointlogbytes: number;
  schema: (db: Db) => Promise<void>;
  verify: (db: Db) => Promise<void>;
  beforeRename?: (temporary: string, final: string) => Promise<void>;
};

// A schema provider owns one database kind's domain tables. Safe create
// applies it in the `.new` stage and every open checks the recorded
// `meta.schema_version` against it — a mismatch or a missing row refuses
// the open (R14; no migrations yet). Version 0 is the empty placeholder.
export type SchemaProvider = {
  readonly version: number;
  apply(db: Db): Promise<void>;
};

export const EMPTY_SCHEMA: SchemaProvider = {
  version: 0,
  apply: () => Promise.resolve(),
};

export const META_SCHEMA =
  'CREATE TABLE meta(k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL)';

export async function applySchema(
  db: Db,
  provider: SchemaProvider,
): Promise<void> {
  if (!Number.isSafeInteger(provider.version) || provider.version < 0) {
    throw new TypeError('schema version must be a non-negative safe integer');
  }
  await db.exec(META_SCHEMA);
  await provider.apply(db);
  await db.execute('INSERT INTO meta VALUES(?, ?)', [
    'schema_version',
    String(provider.version),
  ]);
}

export async function checkSchema(
  db: Db,
  provider: SchemaProvider,
): Promise<void> {
  let rows: Row[];
  try {
    rows = await db.query('SELECT v FROM meta WHERE k = ?', ['schema_version']);
  } catch (error) {
    throw new Error(
      `database has no schema meta table: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (rows.length !== 1) {
    throw new Error('database has no schema version row');
  }
  if (rows[0].v !== String(provider.version)) {
    throw new Error(
      `schema version mismatch: database has ${JSON.stringify(rows[0].v)}, ` +
        `provider wants ${JSON.stringify(String(provider.version))}`,
    );
  }
}

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
