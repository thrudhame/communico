// Private restore candidate access. Unlike openStore, this lifecycle neither
// discovers/creates databases nor executes startup hooks, projection or workers.
import { dirname, join, resolve } from '@std/path';
import { checkBuildInfo } from './build.ts';
import { EMPTY_SCHEMA, ensureSchema, integrityCheck } from './create.ts';
import { type Conn, Db } from './db.ts';
import { Turso } from './ffi.ts';
import type { SnapshotFile, StoreConfig, StoreSchemas } from './index.ts';
import type { CapturedFile, CapturedStore } from './inspect.ts';
import { checkId, keyFor } from './layout.ts';
import { canonicalRoot } from './ownership.ts';

export type CandidateFile = CapturedFile & { migratedTo: number };
export type CandidateStore = Omit<CapturedStore, 'files'> & {
  readonly files: readonly CandidateFile[];
  tx<T>(file: CandidateFile, fn: (conn: Conn) => Promise<T>): Promise<T>;
};

export async function withCandidateStore<T>(
  config: Pick<StoreConfig, 'library' | 'checkpointlogbytes'>,
  root: string,
  files: readonly SnapshotFile[],
  schemas: StoreSchemas,
  prepare: (candidate: CandidateStore) => Promise<T>,
): Promise<T> {
  root = await canonicalRoot(root);
  if (!(await Deno.lstat(root)).isDirectory) {
    throw new Error('restore candidate root missing');
  }
  const ffi = new Turso(config.library);
  const candidates: CandidateFile[] = [];
  const queues = new Map<CandidateFile, Promise<unknown>>();
  let active = true;
  try {
    checkBuildInfo(await ffi.buildInfo());
    const seen = new Set<string>();
    // Preflight the entire path inventory before opening even its first file.
    for (const file of files) {
      if (
        !['server', 'tenants', 'rooms'].includes(file.kind) ||
        (file.kind === 'server') !== (file.id === null) ||
        (file.id !== null && typeof file.id !== 'string')
      ) {
        throw new Error('restore candidate file identity/path mismatch');
      }
      const expected = file.kind === 'server'
        ? 'server/data.db'
        : file.kind + '/' + await keyFor(file.id!) + '/data.db';
      if (file.path !== expected || seen.has(expected)) {
        throw new Error('restore candidate file identity/path mismatch');
      }
      seen.add(expected);
      const path = join(root, file.path);
      if (await Deno.realPath(dirname(path)) !== resolve(dirname(path))) {
        throw new Error('restore candidate symlink directory');
      }
      const stat = await Deno.lstat(path);
      if (!stat.isFile || stat.isSymlink) {
        throw new Error('restore candidate non-regular database');
      }
    }
    if (files.filter((file) => file.kind === 'server').length !== 1) {
      throw new Error('restore candidate server inventory mismatch');
    }
    for (const file of files) {
      const db = await Db.open(
        ffi,
        join(root, file.path),
        config.checkpointlogbytes,
      );
      try {
        await integrityCheck(db);
        if (file.id !== null) await checkId(db, file.id);
        const [{ v }] = await db.query(
          "SELECT v FROM meta WHERE k='schema_version'",
        );
        const schemaVersion = Number(v);
        if (
          typeof v !== 'string' || String(schemaVersion) !== v ||
          !Number.isSafeInteger(schemaVersion) || schemaVersion < 0
        ) throw new Error('restore candidate invalid schema version');
        const provider = schemas[
          file.kind === 'rooms'
            ? 'room'
            : file.kind === 'tenants'
            ? 'tenant'
            : 'server'
        ] ?? EMPTY_SCHEMA;
        await ensureSchema(db, provider);
        await integrityCheck(db);
        candidates.push(
          Object.freeze({
            ...file,
            schemaVersion,
            migratedTo: provider.version,
          }),
        );
      } finally {
        await db.close();
      }
    }
    const tx = <R>(
      file: CandidateFile,
      fn: (conn: Conn) => Promise<R>,
    ): Promise<R> => {
      if (!active) {
        return Promise.reject(new Error('restore candidate is closed'));
      }
      if (!candidates.includes(file)) {
        return Promise.reject(new Error('restore candidate unknown file'));
      }
      const task = (async () => {
        await queues.get(file);
        const db = await Db.open(
          ffi,
          join(root, file.path),
          config.checkpointlogbytes,
        );
        try {
          return await db.tx(fn);
        } finally {
          await db.close();
        }
      })();
      // A rejected body rolls back, but cannot poison later file admission.
      queues.set(file, task.catch(() => {}));
      return task;
    };
    return await prepare({
      files: Object.freeze(candidates),
      tx,
      read(file, fn) {
        return tx(
          file as CandidateFile,
          (conn) => fn({ query: (sql, values) => conn.query(sql, values) }),
        );
      },
    });
  } finally {
    active = false;
    await Promise.allSettled(queues.values());
    ffi.close();
  }
}
