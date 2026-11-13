// api/engine/store/index.ts — the store's public face. Startup order is the
// crash-safety contract: sweep interrupted publications, then open the
// server file, then let the later stages roll forward before serving. Each
// database kind takes a schema provider (R14); the server file always
// carries the store's watermark tables under the provider's own tables.
import { join } from '@std/path';
import { checkBuildInfo } from '#engine/store/build.ts';
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

export class Store implements StartupStore {
  private stopped = false;
  private readonly serverOperations: Database;
  constructor(
    private readonly ffi: Turso,
    private readonly serverDb: Db,
    private readonly pool: Pool,
  ) {
    this.serverOperations = operations((fn, options) => {
      if (this.stopped) throw new Error('store is closed');
      return this.serverDb.tx(fn, options);
    }, this.serverDb.path);
  }

  server(): Promise<Database> {
    return Promise.resolve(this.serverOperations);
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
  leaseRoom(id: string, options: { create?: boolean } = {}): Promise<Lease> {
    return this.pool.acquire('rooms', id, options);
  }

  private async database(
    kind: FileKind,
    id: string,
    options: { create?: boolean },
  ): Promise<Database> {
    // Preserve open/create validation without retaining the opening lease.
    const initial = await this.pool.acquire(kind, id, options);
    const path = initial.db.path;
    const incarnation = initial.incarnation;
    await initial.release();
    return operations(async (fn, txOptions) => {
      const lease = await this.pool.acquire(kind, id, { incarnation });
      try {
        return await lease.db.tx(fn, txOptions);
      } finally {
        await lease.release();
      }
    }, path);
  }

  // The room ids recorded on disk (the server stage's startup discovery).
  rooms(): Promise<string[]> {
    return this.pool.list('rooms');
  }

  tenants(): Promise<string[]> {
    return this.pool.list('tenants');
  }

  /** The engine owns deletion intent/projection; storage owns file retirement. */
  retireRoom(id: string): Promise<void> {
    if (this.stopped) throw new Error('store is closed');
    return this.pool.retire('rooms', id);
  }

  roomRetired(id: string): Promise<boolean> {
    return this.pool.isRetired('rooms', id);
  }

  removeRoom(id: string): Promise<void> {
    if (this.stopped) throw new Error('store is closed');
    return this.pool.remove('rooms', id);
  }

  initializeRoom<T>(id: string, fn: (db: Database) => Promise<T>): Promise<T> {
    return this.pool.initialize('rooms', id, fn);
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
    await this.pool.close();
    await this.serverDb.close();
    this.ffi.close();
  }
}

export async function openStore(
  config: StoreConfig,
  options: { schemas?: StoreSchemas } = {},
): Promise<Store> {
  const ffi = new Turso(config.library);
  let serverDb: Db | undefined;
  let pool: Pool | undefined;
  try {
    checkBuildInfo(await ffi.buildInfo());
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
    const store = new Store(ffi, serverDb, pool);
    for (const hook of startupHooks()) await hook(store);
    return store;
  } catch (error) {
    try {
      await pool?.close();
      await serverDb?.close();
      ffi.close();
    } catch {
      // Unwinding must not mask the startup error thrown below.
    }
    throw error;
  }
}
