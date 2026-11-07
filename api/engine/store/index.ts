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
  type SchemaProvider,
  sweep,
} from '#engine/store/create.ts';
import { Db } from '#engine/store/db.ts';
import { type GateStats } from '#engine/store/gate.ts';
import { Turso } from '#engine/store/ffi.ts';
import { databaseFiles, serverDirectory } from '#engine/store/layout.ts';
import { Pool } from '#engine/store/pool.ts';
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
  server: GateStats;
};

export class Store implements StartupStore {
  constructor(
    private readonly ffi: Turso,
    private readonly serverDb: Db,
    private readonly pool: Pool,
  ) {}

  server(): Promise<Db> {
    return Promise.resolve(this.serverDb);
  }

  room(id: string, options: { create?: boolean } = {}): Promise<Db> {
    return this.pool.acquire('rooms', id, options);
  }

  tenant(id: string, options: { create?: boolean } = {}): Promise<Db> {
    return this.pool.acquire('tenants', id, options);
  }

  // The room ids recorded on disk (the server stage's startup discovery).
  rooms(): Promise<string[]> {
    return this.pool.list('rooms');
  }

  initializeRoom<T>(id: string, fn: (db: Db) => Promise<T>): Promise<T> {
    return this.pool.initialize('rooms', id, fn);
  }

  stats(): StoreStats {
    return {
      openFiles: this.pool.size,
      poolErrors: this.pool.errors.slice(),
      server: this.serverDb.gate.stats(),
    };
  }

  async close(): Promise<void> {
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
    await checkSchema(serverDb, serverProvider);
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
