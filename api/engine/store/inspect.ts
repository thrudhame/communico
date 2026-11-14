// Captured files are immutable inputs. Only store-owned private copies are
// opened, integrity checked and (when requested) migrated. No startup hooks,
// discovery, identity creation or background workers run during inspection.
import { dirname, join, resolve } from '@std/path';
import { checkBuildInfo } from './build.ts';
import { EMPTY_SCHEMA, ensureSchema, integrityCheck } from './create.ts';
import { type Conn, Db } from './db.ts';
import { copyPrivate } from './files.ts';
import { Turso } from './ffi.ts';
import type { SnapshotFile, StoreConfig, StoreSchemas } from './index.ts';
import { checkId, keyFor } from './layout.ts';

export type CapturedFile = SnapshotFile & { schemaVersion: number };
export type CapturedQuery = Pick<Conn, 'query'>;
export type CapturedStore = {
  readonly files: readonly CapturedFile[];
  read<T>(
    file: CapturedFile,
    fn: (db: CapturedQuery) => Promise<T>,
  ): Promise<T>;
};

async function canonicalDirectory(path: string): Promise<string> {
  path = resolve(path);
  if (
    await Deno.realPath(path) !== path || !(await Deno.lstat(path)).isDirectory
  ) {
    throw new Error('captured store: symlink or invalid directory');
  }
  return path;
}

export async function inspectSnapshot<T>(
  config: Pick<StoreConfig, 'library' | 'checkpointlogbytes'>,
  root: string,
  files: readonly SnapshotFile[],
  workspace: string,
  schemas: StoreSchemas,
  inspect: (snapshot: CapturedStore) => Promise<T>,
): Promise<T> {
  root = await canonicalDirectory(root);
  workspace = await canonicalDirectory(workspace);
  const ffi = new Turso(config.library);
  let stage: string | undefined;
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const captured: CapturedFile[] = [];
  try {
    stage = await Deno.makeTempDir({ dir: workspace, prefix: '.inspect-' });
    const scratch = stage;
    checkBuildInfo(await ffi.buildInfo());
    const seen = new Set<string>();
    for (const file of files) {
      const expected = file.kind === 'server'
        ? 'server/data.db'
        : file.kind + '/' + await keyFor(file.id!) + '/data.db';
      if (
        (file.kind === 'server') !== (file.id === null) ||
        !['server', 'tenants', 'rooms'].includes(file.kind) ||
        file.path !== expected || seen.has(file.path)
      ) throw new Error('captured store: file identity/path mismatch');
      seen.add(file.path);
      await canonicalDirectory(join(root, dirname(file.path)));
      const target = join(stage, file.path);
      await Deno.mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyPrivate(join(root, file.path), target);
      const db = await Db.open(ffi, target, config.checkpointlogbytes);
      try {
        await integrityCheck(db);
        if (file.id !== null) await checkId(db, file.id);
        const rows = await db.query(
          "SELECT v FROM meta WHERE k='schema_version'",
        );
        const value = rows.length === 1 ? rows[0].v : undefined;
        const version = Number(value);
        if (
          typeof value !== 'string' || String(version) !== value ||
          !Number.isSafeInteger(version) || version < 0
        ) {
          throw new Error('captured store: invalid schema version');
        }
        const provider = schemas[
          file.kind === 'rooms'
            ? 'room'
            : file.kind === 'tenants'
            ? 'tenant'
            : 'server'
        ] ?? EMPTY_SCHEMA;
        await ensureSchema(db, provider);
        await integrityCheck(db);
        captured.push(Object.freeze({ ...file, schemaVersion: version }));
      } finally {
        await db.close();
      }
    }
    if (captured.filter((f) => f.kind === 'server').length !== 1) {
      throw new Error('captured store: server inventory mismatch');
    }
    const snapshot: CapturedStore = {
      files: Object.freeze(captured),
      read<R>(
        file: CapturedFile,
        fn: (db: CapturedQuery) => Promise<R>,
      ): Promise<R> {
        if (closed) {
          return Promise.reject(new Error('captured store is closed'));
        }
        if (!captured.includes(file)) {
          return Promise.reject(new Error('captured store: unknown file'));
        }
        const task = (async () => {
          const db = await Db.open(
            ffi,
            join(scratch, file.path),
            config.checkpointlogbytes,
          );
          try {
            return await db.tx(
              (conn) => fn({ query: (sql, values) => conn.query(sql, values) }),
              { mode: 'deferred' },
            );
          } finally {
            await db.close();
          }
        })();
        active.add(task);
        return task.finally(() => active.delete(task));
      },
    };
    return await inspect(snapshot);
  } finally {
    closed = true;
    await Promise.allSettled(active);
    try {
      ffi.close();
    } finally {
      if (stage !== undefined) await Deno.remove(stage, { recursive: true });
    }
  }
}
