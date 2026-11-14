// api/engine/store/index.ts — the store's public face. Startup order is the
// crash-safety contract: sweep interrupted publications, then open the
// server file, then let the later stages roll forward before serving. Each
// database kind takes a schema provider (R14); the server file always
// carries the store's watermark tables under the provider's own tables.
import { dirname, join } from '@std/path';
import { publish, removeOwned } from '#engine/store/files.ts';
import {
  assertNoPromotion,
  canonicalRoot,
  ownershipPath,
} from '#engine/store/ownership.ts';
import { type BuildInfo, checkBuildInfo } from '#engine/store/build.ts';
import { Admission } from '#engine/store/admission.ts';
import type { ReadSnapshot } from '#engine/store/export.ts';
import {
  applySchema,
  checkSchema,
  createDatabase,
  EMPTY_SCHEMA,
  ensureSchema,
  type SchemaProvider,
  sweep,
} from '#engine/store/create.ts';
import {
  type ConflictStats,
  type Database,
  Db,
  operations,
} from '#engine/store/db.ts';
import type { FileKind } from '#engine/store/layout.ts';
import { type GateStats } from '#engine/store/gate.ts';
import { Turso } from '#engine/store/ffi.ts';
import { databaseFiles, serverDirectory } from '#engine/store/layout.ts';
import { type Lease, Pool, type SnapshotSource } from '#engine/store/pool.ts';
import {
  ensureWatermarks,
  startupHooks,
  type StartupStore,
} from '#engine/store/watermark.ts';

export type StoreConfig = {
  dir: string;
  library: string;
  checkpointlogbytes: number;
  maxopenfiles: number;
  idleseconds: number;
};

export type StoreSchemas = {
  room?: SchemaProvider;
  tenant?: SchemaProvider;
  server?: SchemaProvider;
};

export type StoreStats = {
  openFiles: number;
  poolErrors: readonly Error[];
  server: GateStats & { conflicts: ConflictStats };
};

export type SnapshotFile = {
  kind: 'server' | FileKind;
  id: string | null;
  path: string;
};

export class Store implements StartupStore {
  private stopped = false;
  private closing?: Promise<void>;
  private readonly maintenance = new Set<Promise<unknown>>();
  private readonly serverOperations: Database;
  constructor(
    private readonly ffi: Turso,
    private readonly serverDb: Db,
    private readonly pool: Pool,
    private readonly ownership: number,
    private readonly admission: Admission,
  ) {
    this.serverOperations = operations(
      (fn, options) => this.run(() => this.serverDb.tx(fn, options)),
      this.serverDb.path,
    );
  }

  server(): Promise<Database> {
    return Promise.resolve(this.serverOperations);
  }

  get directory(): string {
    return dirname(dirname(this.serverDb.path));
  }

  // Bundle bytes are prepared by the engine; only storage owns native durable
  // no-replace publication. Shutdown drains this maintenance operation too.
  publishSnapshot(source: string, destination: string): Promise<void> {
    if (this.stopped) return Promise.reject(new Error('store is closed'));
    return this.maintain(publish(this.ffi, source, destination));
  }

  // Accepted work owns a lifetime independently of the short commit/publication
  // fence. Shutdown must drain it without blocking its final commit.
  private maintain<T>(task: Promise<T>): Promise<T> {
    this.maintenance.add(task);
    return task.finally(() => this.maintenance.delete(task));
  }

  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('store is closed'));
    return this.maintain(Promise.resolve().then(fn));
  }

  async room(
    id: string,
    options: { create?: boolean } = {},
  ): Promise<Database> {
    return await this.database('rooms', id, options);
  }

  async tenant(
    id: string,
    options: { create?: boolean } = {},
  ): Promise<Database> {
    return await this.database('tenants', id, options);
  }

  // Explicit multi-transaction operation (e.g. a checkpoint-observed bulk
  // writer). The caller must release in finally; shutdown drains leases.
  async leaseRoom(
    id: string,
    options: { create?: boolean } = {},
  ): Promise<Lease> {
    const lease = await this.run(() => this.pool.acquire('rooms', id, options));
    return {
      ...lease,
      db: operations(
        (fn, txOptions) => this.run(() => lease.db.tx(fn, txOptions)),
        lease.db.path,
      ),
    };
  }

  private async database(
    kind: FileKind,
    id: string,
    options: { create?: boolean },
  ): Promise<Database> {
    // Preserve open/create validation without retaining the opening lease.
    return await this.run(async () => {
      const initial = await this.pool.acquire(kind, id, options);
      const path = initial.db.path;
      const incarnation = initial.incarnation;
      await initial.release();
      return operations((fn, txOptions) =>
        this.run(async () => {
          const lease = await this.pool.acquire(kind, id, { incarnation });
          try {
            return await lease.db.tx(fn, txOptions);
          } finally {
            await lease.release();
          }
        }), path);
    });
  }

  // The room ids recorded on disk (the server stage's startup discovery).
  rooms(): Promise<string[]> {
    return this.run(() => this.pool.list('rooms'));
  }

  tenants(): Promise<string[]> {
    return this.run(() => this.pool.list('tenants'));
  }

  /** The engine owns deletion intent/projection; storage owns file retirement. */
  retireRoom(id: string): Promise<void> {
    return this.run(() => this.pool.retire('rooms', id));
  }

  roomRetired(id: string): Promise<boolean> {
    return this.run(() => this.pool.isRetired('rooms', id));
  }

  removeRoom(id: string): Promise<void> {
    if (this.stopped) throw new Error('store is closed');
    // Lease/backup retention waits must not remain admitted: the next common
    // cut needs to drain admission before its readers can finish and release.
    return this.maintain(
      this.pool.remove('rooms', id, (fn) => this.admission.run(fn)),
    );
  }

  initializeRoom<T>(id: string, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.run(() => this.pool.initialize('rooms', id, fn));
  }

  // One crash-consistent cut for every file, including inactive rooms/tenants.
  // The caller owns a private, unpublished bundle and later audits/fsyncs it.
  snapshot(
    destination: string,
  ): Promise<{ files: SnapshotFile[]; pauseMs: number; native: BuildInfo }> {
    if (this.stopped) return Promise.reject(new Error('store is closed'));
    return this.maintain(this.captureSnapshot(destination));
  }

  private async captureSnapshot(
    destination: string,
  ): Promise<{ files: SnapshotFile[]; pauseMs: number; native: BuildInfo }> {
    const staging = await Deno.makeTempDir({
      dir: dirname(dirname(this.serverDb.path)),
      prefix: '.backup-',
      suffix: '.new',
    });
    const sources = new Map<string, SnapshotSource>();
    const readers: {
      file: SnapshotFile;
      reader: ReadSnapshot;
      release(): Promise<void>;
    }[] = [];
    let server: Awaited<ReturnType<Db['prepareReadSnapshot']>> | undefined;
    let pauseMs = 0;
    const releaseSources = async () => {
      // Settle every owner even if one release fails; never leak a later native
      // reader or lifecycle hold after an earlier export/pin/cleanup error.
      const released = await Promise.allSettled([
        ...[...sources.values()].map((source) => source.release()),
        ...(server ? [server.release()] : []),
      ]);
      await removeOwned(staging);
      const errors = released.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : []
      );
      if (errors.length) {
        throw new AggregateError(errors, 'snapshot release failed');
      }
    };
    try {
      server = await this.serverDb.prepareReadSnapshot();
      for (;;) {
        if (this.stopped) throw new Error('store is closed');
        // Replay/open/migrate and connect before pausing commits/publications. The
        // physical holds prevent unlink/recreation while this set is prepared.
        for (const { kind, key } of await this.pool.snapshotInventory()) {
          const identity = kind + '/' + key;
          if (sources.has(identity)) continue;
          const source = await this.pool.retainSnapshot(kind, key);
          if (source) sources.set(identity, source);
        }
        const result = await this.admission.exclusive(async () => {
          if (this.stopped) throw new Error('store is closed');
          const inventory = await this.pool.snapshotInventory();
          if (
            inventory.length !== sources.size ||
            inventory.some(({ kind, key }) => !sources.has(kind + '/' + key))
          ) {
            return false;
          }
          readers.push({
            file: { kind: 'server', id: null, path: 'server/data.db' },
            reader: await server!.pin(),
            release: () => server!.release(),
          });
          for (const { kind, key } of inventory) {
            const source = sources.get(kind + '/' + key)!;
            readers.push({
              file: {
                kind,
                id: source.id,
                path: kind + '/' + key + '/data.db',
              },
              reader: await source.prepared.pin(),
              release: () => source.release(),
            });
          }
          return true;
        });
        pauseMs += result.pauseMs;
        if (result.value) break;
      }
      for (const { file, reader, release } of readers) {
        try {
          const path = join(staging, file.path);
          await Deno.mkdir(dirname(path), { recursive: true, mode: 0o700 });
          await reader.export(path);
        } finally {
          // Each completed file releases its reader immediately, so catch-up
          // maintenance need not wait for the remaining database/media exports.
          await release();
        }
      }
      await publish(this.ffi, staging, destination);
      return {
        files: readers.map(({ file }) => file),
        pauseMs,
        native: await this.ffi.buildInfo(),
      };
    } finally {
      await releaseSources();
    }
  }

  stats(): StoreStats {
    return {
      openFiles: this.pool.size,
      poolErrors: this.pool.errors.slice(),
      server: {
        ...this.serverDb.gate.stats(),
        conflicts: this.serverDb.conflictStats(),
      },
    };
  }

  async close(): Promise<void> {
    this.stopped = true;
    await (this.closing ??= (async () => {
      await Promise.allSettled(this.maintenance);
      // Accepted operations can still need their native commit/publication.
      // Never close that admission while draining the owners that use it.
      await this.pool.close();
      await this.serverDb.close();
      await this.ffi.unlockStore(this.ownership);
      this.ffi.close();
    })());
  }
}

export async function openStore(
  config: StoreConfig,
  options: {
    schemas?: StoreSchemas;
    beforeStartup?(store: Store): Promise<unknown>;
  } = {},
): Promise<Store> {
  const ffi = new Turso(config.library);
  let serverDb: Db | undefined;
  let pool: Pool | undefined;
  let ownership: number | undefined;
  const admission = new Admission();
  try {
    checkBuildInfo(await ffi.buildInfo());
    config = { ...config, dir: await canonicalRoot(config.dir) };
    await Deno.mkdir(dirname(config.dir), { recursive: true, mode: 0o700 });
    ownership = await ffi.lockStore(await ownershipPath(config.dir));
    await assertNoPromotion(config.dir);
    await Deno.mkdir(config.dir, { recursive: true, mode: 0o700 });
    await sweep(config.dir);
    await sweep(join(config.dir, 'rooms'));
    await sweep(join(config.dir, 'tenants'));
    const serverProvider: SchemaProvider = {
      version: (options.schemas?.server ?? EMPTY_SCHEMA).version,
      migrations: options.schemas?.server?.migrations,
      apply: async (db) => {
        await ensureWatermarks(db);
        await (options.schemas?.server ?? EMPTY_SCHEMA).apply(db);
      },
    };
    const serverPath = databaseFiles(serverDirectory(config.dir)).database;
    let present = false;
    try {
      present = (await Deno.stat(serverPath)).isFile;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (!present) {
      await Deno.mkdir(config.dir, { recursive: true });
      await createDatabase(ffi, config.dir, 'server', {
        checkpointlogbytes: config.checkpointlogbytes,
        schema: (db) => applySchema(db, serverProvider),
        verify: (db) => checkSchema(db, serverProvider),
      });
    }
    serverDb = await Db.open(
      ffi,
      serverPath,
      config.checkpointlogbytes,
      admission,
    );
    await ensureSchema(serverDb, serverProvider);
    pool = new Pool(ffi, config.dir, {
      checkpointlogbytes: config.checkpointlogbytes,
      maxopenfiles: config.maxopenfiles,
      idleseconds: config.idleseconds,
    }, {
      rooms: options.schemas?.room,
      tenants: options.schemas?.tenant,
    }, admission);
    const store = new Store(ffi, serverDb, pool, ownership, admission);
    // The composition root binds runtime authority before a recovery hook may
    // project data or schedule owner-specific intents. Failure unwinds the pool.
    await options.beforeStartup?.(store);
    for (const hook of startupHooks()) await hook(store);
    return store;
  } catch (error) {
    try {
      await pool?.close();
      await serverDb?.close();
      if (ownership !== undefined) await ffi.unlockStore(ownership);
      ffi.close();
    } catch {
      // Unwinding must not mask the startup error thrown below.
    }
    throw error;
  }
}
