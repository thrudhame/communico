// api/engine/store/create.ts — publish only a closed, reopened, verified and
// fsynced database. Failed creation is deliberately left for startup sweep.
// Schema providers own each database kind's domain tables; the store owns
// the meta table and upgrades only explicitly supported versions (R14).
import { basename, join } from '@std/path';
import { type Conn, type Database, Db } from '#engine/store/db.ts';
import { type Row, Turso } from '#engine/store/ffi.ts';
import { databaseFiles } from '#engine/store/layout.ts';
import type { Admission } from '#engine/store/admission.ts';

export type CreateOptions = {
  checkpointlogbytes: number;
  schema: (db: Database) => Promise<void>;
  verify: (db: Database) => Promise<void>;
  beforeRename?: (temporary: string, final: string) => Promise<void>;
  discardOnFailure?: boolean;
  publication?: Admission;
};

// A schema provider owns one database kind's domain tables. Safe create
// applies it in the `.new` stage and every open checks the recorded
// `meta.schema_version` against it. Known upgrade steps are atomic; unknown
// versions and missing metadata refuse the open. Version 0 is empty.
export type SchemaProvider = {
  readonly version: number;
  apply(db: Database): Promise<void>;
  // Explicit supported v -> v+1 steps. The store owns their transaction.
  readonly migrations?: Readonly<Record<number, (conn: Conn) => Promise<void>>>;
};

export const EMPTY_SCHEMA: SchemaProvider = {
  version: 0,
  apply: () => Promise.resolve(),
};

export const META_SCHEMA =
  'CREATE TABLE meta(k TEXT PRIMARY KEY NOT NULL, v TEXT NOT NULL)';

export async function applySchema(
  db: Database,
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
  db: Database,
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

/** Upgrade only a fully known chain, atomically with its version marker.
 * Opens run this before exposing a handle. Unknown/forward versions still fail.
 * Bodies obey the same retry contract as every other storage transaction. */
export async function ensureSchema(
  db: Database,
  provider: SchemaProvider,
): Promise<void> {
  if (!Number.isSafeInteger(provider.version) || provider.version < 0) {
    throw new TypeError('schema version must be a non-negative safe integer');
  }
  await db.tx(async (conn) => {
    const rows = await conn.query('SELECT v FROM meta WHERE k = ?', [
      'schema_version',
    ]);
    const value = rows.length === 1 ? rows[0].v : undefined;
    if (value === String(provider.version)) return;
    const version = Number(value);
    if (
      typeof value !== 'string' || String(version) !== value ||
      !Number.isSafeInteger(version) || version < 0 ||
      version > provider.version
    ) {
      throw new Error(
        `schema version mismatch: database has ${
          JSON.stringify(value)
        }, provider wants ${provider.version}`,
      );
    }
    // Preflight prevents a partial upgrade when an intermediate step is absent.
    for (let v = version; v < provider.version; v++) {
      if (!provider.migrations?.[v]) {
        throw new Error(
          `schema version mismatch: no supported migration from ${v}`,
        );
      }
    }
    for (let v = version; v < provider.version; v++) {
      await provider.migrations![v](conn);
      await conn.execute('UPDATE meta SET v = ? WHERE k = ?', [
        String(v + 1),
        'schema_version',
      ]);
    }
  }, { mode: 'deferred' });
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

export async function integrityCheck(db: Database): Promise<void> {
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
  // Only this invocation's successfully reserved staging directory is ours
  // to discard. Never remove an existing final or another creator's stage.
  try {
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
    const publish = async () => {
      await Deno.rename(temporary, final);
      await sync(parent);
    };
    if (options.publication) await options.publication.run(publish);
    else await publish();
    return final;
  } catch (error) {
    if (options.discardOnFailure) {
      try {
        await Deno.remove(temporary, { recursive: true });
        await sync(parent);
      } catch (cleanup) {
        if (!(cleanup instanceof Deno.errors.NotFound)) {
          throw new AggregateError(
            [error, cleanup],
            'database creation cleanup failed',
          );
        }
      }
    }
    throw error;
  }
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
