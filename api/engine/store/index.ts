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
import {
  databaseFiles,
  keyFor,
  serverDirectory,
} from '#engine/store/layout.ts';
import { type Lease, Pool } from '#engine/store/pool.ts';
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
  private readonly admission = new Admission();
  private readonly snapshots = new Set<Promise<unknown>>();
  private readonly serverOperations: Database;
  constructor(
    private readonly ffi: Turso,
    private readonly serverDb: Db,
    private readonly pool: Pool,
    private readonly ownership: number,
  ) {
    this.serverOperations = operations(
      (fn, options) =>
        this.admission.run(() => {
          if (this.stopped) throw new Error('store is closed');
          return this.serverDb.tx(fn, options);
        }),
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
    const task = publish(this.ffi, source, destination);
    this.snapshots.add(task);
    return task.finally(() => this.snapshots.delete(task));
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
    const lease = await this.admission.run(() => {
      if (this.stopped) throw new Error('store is closed');
      return this.pool.acquire('rooms', id, options);
    });
    return {
      ...lease,
      db: operations((fn, txOptions) =>
        this.admission.run(() => {
          if (this.stopped) throw new Error('store is closed');
          return lease.db.tx(fn, txOptions);
        }), lease.db.path),
    };
  }

  private async database(
    kind: FileKind,
    id: string,
    options: { create?: boolean },
  ): Promise<Database> {
    // Preserve open/create validation without retaining the opening lease.
    const initial = await this.admission.run(() => {
      if (this.stopped) throw new Error('store is closed');
      return this.pool.acquire(kind, id, options);
    });
    const path = initial.db.path;
    const incarnation = initial.incarnation;
    await initial.release();
    return operations((fn, txOptions) =>
      this.admission.run(async () => {
        if (this.stopped) throw new Error('store is closed');
        const lease = await this.pool.acquire(kind, id, { incarnation });
        try {
          return await lease.db.tx(fn, txOptions);
        } finally {
          await lease.release();
        }
      }), path);
  }

  // The room ids recorded on disk (the server stage's startup discovery).
  rooms(): Promise<string[]> {
    return this.admission.run(() => this.pool.list('rooms'));
  }

  tenants(): Promise<string[]> {
    return this.admission.run(() => this.pool.list('tenants'));
  }

  /** The engine owns deletion intent/projection; storage owns file retirement. */
  retireRoom(id: string): Promise<void> {
    if (this.stopped) throw new Error('store is closed');
    return this.admission.run(() => this.pool.retire('rooms', id));
  }

  roomRetired(id: string): Promise<boolean> {
    return this.admission.run(() => this.pool.isRetired('rooms', id));
  }

  removeRoom(id: string): Promise<void> {
    if (this.stopped) throw new Error('store is closed');
    return this.admission.run(() => this.pool.remove('rooms', id));
  }

  initializeRoom<T>(id: string, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.admission.run(() => this.pool.initialize('rooms', id, fn));
  }

  // One crash-consistent cut for every file, including inactive rooms/tenants.
  // The caller owns a private, unpublished bundle and later audits/fsyncs it.
  snapshot(
    destination: string,
  ): Promise<{ files: SnapshotFile[]; pauseMs: number; native: BuildInfo }> {
    if (this.stopped) return Promise.reject(new Error('store is closed'));
    const task = this.captureSnapshot(destination);
    this.snapshots.add(task);
    return task.finally(() => this.snapshots.delete(task));
  }

  private async captureSnapshot(
    destination: string,
  ): Promise<{ files: SnapshotFile[]; pauseMs: number; native: BuildInfo }> {
    const staging = await Deno.makeTempDir({
      dir: dirname(dirname(this.serverDb.path)),
      prefix: '.backup-',
      suffix: '.new',
    });
    try {
      const result = await this.admission.exclusive(async () => {
        if (this.stopped) throw new Error('store is closed');
        const files: SnapshotFile[] = [{
          kind: 'server',
          id: null,
          path: 'server/data.db',
        }];
        for (const kind of ['tenants', 'rooms'] as const) {
          for (const id of await this.pool.list(kind)) {
            // Normalize any supported schema before any snapshot is taken.
            await this.pool.prepareSnapshot(kind, id);
            files.push({
              kind,
              id,
              path: kind + '/' + await keyFor(id) + '/data.db',
            });
          }
        }
        for (const file of files) {
          const path = join(staging, file.path);
          await Deno.mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
          if (file.kind === 'server') {
            await this.serverDb.vacuumInto(path);
          } else {
            await this.pool.vacuumInto(file.kind, file.id!, path);
          }
        }
        return files;
      });
      await publish(this.ffi, staging, destination);
      return {
        files: result.value,
        pauseMs: result.pauseMs,
        native: await this.ffi.buildInfo(),
      };
    } finally {
      await removeOwned(staging);
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
      await Promise.allSettled(this.snapshots);
      await this.admission.exclusive(async () => {
        await this.pool.close();
        await this.serverDb.close();
        await this.ffi.unlockStore(this.ownership);
        this.ffi.close();
      });
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
    serverDb = await Db.open(ffi, serverPath, config.checkpointlogbytes);
    await ensureSchema(serverDb, serverProvider);
    pool = new Pool(ffi, config.dir, {
      checkpointlogbytes: config.checkpointlogbytes,
      maxopenfiles: config.maxopenfiles,
      idleseconds: config.idleseconds,
    }, {
      rooms: options.schemas?.room,
      tenants: options.schemas?.tenant,
    });
    const store = new Store(ffi, serverDb, pool, ownership);
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
