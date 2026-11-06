// api/engine/store/pool.ts — the open-file pool. One entry per room/tenant
// file; eviction never touches a file in use or one whose gate is paused.
// Creation applies the kind's schema provider inside the `.new` stage and
// every open checks the recorded schema version (R14).
import { join } from '@std/path';
import {
  applySchema,
  checkSchema,
  createDatabase,
  EMPTY_SCHEMA,
  type SchemaProvider,
} from '#engine/store/create.ts';
import { type Database, Db, operations } from '#engine/store/db.ts';
import type { Turso } from '#engine/store/ffi.ts';
import {
  checkId,
  databaseFiles,
  directory,
  type FileKind,
  keyFor,
  recordId,
} from '#engine/store/layout.ts';

export type PoolOptions = {
  checkpointlogbytes: number;
  maxopenfiles: number;
  idleseconds: number;
};

type Entry = {
  db: Db;
  lastUsed: number;
  leases: number;
};

export type Lease = {
  readonly db: Database;
  readonly events: EventTarget;
  readonly incarnation: symbol;
  release(): Promise<void>;
};

export class Pool {
  private readonly entries = new Map<string, Entry>();
  readonly errors: Error[] = [];
  private readonly sweeper: ReturnType<typeof setInterval>;
  private readonly providers: Record<FileKind, SchemaProvider>;
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly released: (() => void)[] = [];
  private closing?: Promise<void>;
  private readonly removing = new Set<string>();
  // Unlink failure does not undo logical retirement. Only successful removal
  // clears this fence; a restart replays the durable room drop before serving.
  private readonly retiring = new Set<string>();
  private readonly incarnations = new Map<string, symbol>();

  private retireKey(key: string): void {
    if (this.retiring.has(key)) return;
    this.retiring.add(key);
    this.incarnations.set(key, Symbol());
  }

  /** Fence new leases as soon as the engine has committed deletion intent,
   * before fallible server cleanup or physical removal begins. */
  async retire(kind: FileKind, id: string): Promise<void> {
    const key = kind + ':' + await keyFor(id);
    await this.locked(() => {
      if (this.closed) throw new Error('open-file pool is closed');
      this.retireKey(key);
    });
  }

  // Opening, leasing and eviction share one metadata critical section.
  // File operations run OUTSIDE it, protected by their lease count.
  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  constructor(
    private readonly ffi: Turso,
    private readonly root: string,
    private readonly options: PoolOptions,
    providers: Partial<Record<FileKind, SchemaProvider>> = {},
  ) {
    this.providers = {
      rooms: providers.rooms ?? EMPTY_SCHEMA,
      tenants: providers.tenants ?? EMPTY_SCHEMA,
    };
    if (
      !Number.isSafeInteger(options.maxopenfiles) || options.maxopenfiles < 1
    ) {
      throw new TypeError('maxopenfiles must be a positive safe integer');
    }
    if (
      !Number.isSafeInteger(options.idleseconds) || options.idleseconds < 1
    ) {
      throw new TypeError('idleseconds must be a positive safe integer');
    }
    this.sweeper = setInterval(
      () => this.idleSweep(),
      Math.max(1, Math.floor(options.idleseconds / 2)) * 1000,
    );
    Deno.unrefTimer(Number(this.sweeper));
  }

  get size(): number {
    return this.entries.size;
  }

  private evictable(entry: Entry): boolean {
    return entry.leases === 0 && !entry.db.inUse &&
      !entry.db.gate.stats().closed;
  }

  private async drop(key: string, entry: Entry): Promise<void> {
    this.entries.delete(key);
    try {
      await entry.db.close();
    } catch (error) {
      this.errors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  }

  private idleSweep(): void {
    void this.locked(async () => {
      if (this.closed) return;
      const cutoff = Date.now() - this.options.idleseconds * 1000;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < cutoff && this.evictable(entry)) {
          await this.drop(key, entry);
        }
      }
    }).catch((error) =>
      this.errors.push(
        error instanceof Error ? error : new Error(String(error)),
      )
    );
  }

  private async evictToLimit(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxopenfiles) return;
      if (this.evictable(entry)) await this.drop(key, entry);
    }
  }

  // The ids recorded on disk for one kind (the server stage's startup
  // discovery): every directory's file is opened, its id row read, then
  // released. Files already pooled stay pooled (the open dedups by path).
  async list(kind: FileKind): Promise<string[]> {
    const parent = join(this.root, kind);
    const entries: Deno.DirEntry[] = [];
    try {
      for await (const entry of Deno.readDir(parent)) entries.push(entry);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory || entry.name.endsWith('.new')) continue;
      const files = databaseFiles(directory(this.root, kind, entry.name));
      let db: Db;
      try {
        db = await Db.open(
          this.ffi,
          files.database,
          this.options.checkpointlogbytes,
        );
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      try {
        const rows = await db.query('SELECT value FROM id');
        if (rows.length === 1 && typeof rows[0].value === 'string') {
          ids.push(rows[0].value);
        }
      } finally {
        await db.close();
      }
    }
    return ids;
  }

  async acquire(
    kind: FileKind,
    id: string,
    options: { create?: boolean; incarnation?: symbol } = {},
  ): Promise<Lease> {
    return await this.locked(async () => {
      if (this.closed) throw new Error('open-file pool is closed');
      const fileKey = await keyFor(id);
      const key = kind + ':' + fileKey;
      if (!this.incarnations.has(key)) this.incarnations.set(key, Symbol());
      const incarnation = this.incarnations.get(key)!;
      if (
        this.removing.has(key) || this.retiring.has(key) ||
        (options.incarnation !== undefined &&
          options.incarnation !== incarnation)
      ) {
        throw new Deno.errors.NotFound(`removed ${kind} database: ${id}`);
      }
      let entry = this.entries.get(key);
      if (entry === undefined) {
        entry = {
          db: await this.open(kind, id, fileKey, options),
          leases: 0,
          lastUsed: Date.now(),
        };
      }
      entry.leases++;
      entry.lastUsed = Date.now();
      this.entries.delete(key);
      this.entries.set(key, entry);
      await this.evictToLimit();
      let released = false;
      const leased = entry;
      return {
        incarnation,
        events: leased.db.gate,
        db: operations((fn, txOptions) => {
          if (released) throw new Error('database lease has been released');
          return leased.db.tx(fn, txOptions);
        }, leased.db.path),
        release: async () => {
          if (released) return;
          released = true;
          await this.locked(async () => {
            leased.leases--;
            leased.lastUsed = Date.now();
            await this.evictToLimit();
            for (const wake of this.released.splice(0)) wake();
          });
        },
      };
    });
  }

  /** Retire this file incarnation, drain leases, close, then unlink its directory.
   * Metadata waits never hold the queue needed by lease.release(). */
  async remove(kind: FileKind, id: string): Promise<void> {
    const fileKey = await keyFor(id);
    const key = kind + ':' + fileKey;
    await this.locked(() => {
      if (this.closed) throw new Error('open-file pool is closed');
      if (this.removing.has(key)) {
        throw new Error(`removal already in progress: ${id}`);
      }
      this.removing.add(key);
      this.retireKey(key);
    });
    try {
      for (;;) {
        const waiting = await this.locked(async () => {
          const entry = this.entries.get(key);
          if (entry !== undefined && entry.leases > 0) {
            return {
              wait: new Promise<void>((resolve) => this.released.push(resolve)),
            };
          }
          if (entry !== undefined) {
            await entry.db.close();
            this.entries.delete(key);
          }
          const dir = directory(this.root, kind, fileKey);
          try {
            const info = await Deno.lstat(dir);
            if (!info.isDirectory) {
              throw new Error(`not a database directory: ${dir}`);
            }
            await Deno.remove(dir, { recursive: true });
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
          this.retiring.delete(key);
          return null;
        });
        if (waiting === null) return;
        await waiting.wait;
      }
    } finally {
      await this.locked(() => {
        this.removing.delete(key);
      });
    }
  }

  private async open(
    kind: FileKind,
    id: string,
    key: string,
    options: { create?: boolean },
  ): Promise<Db> {
    const parent = join(this.root, kind);
    const dir = directory(this.root, kind, key);
    const files = databaseFiles(dir);
    let present = false;
    try {
      present = (await Deno.stat(files.database)).isFile;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (!present) {
      if (!options.create) {
        throw new Deno.errors.NotFound(
          `no ${kind} database for ${JSON.stringify(id)}: ${files.database}`,
        );
      }
      await Deno.mkdir(parent, { recursive: true });
      const provider = this.providers[kind];
      await createDatabase(this.ffi, parent, key, {
        checkpointlogbytes: this.options.checkpointlogbytes,
        schema: async (db) => {
          await recordId(db, id);
          await applySchema(db, provider);
        },
        verify: async (db) => {
          await checkId(db, id);
          await checkSchema(db, provider);
        },
      });
    }
    const db = await Db.open(
      this.ffi,
      files.database,
      this.options.checkpointlogbytes,
    );
    try {
      await checkId(db, id);
      await checkSchema(db, this.providers[kind]);
    } catch (error) {
      await db.close();
      throw error;
    }
    return db;
  }

  close(): Promise<void> {
    if (this.closing !== undefined) return this.closing;
    this.closed = true;
    clearInterval(this.sweeper);
    this.closing = this.finishClose();
    return this.closing;
  }

  private async finishClose(): Promise<void> {
    for (;;) {
      const waiting = await this.locked(async () => {
        if ([...this.entries.values()].some((entry) => entry.leases > 0)) {
          return {
            wait: new Promise<void>((resolve) => this.released.push(resolve)),
          };
        }
        for (const [key, entry] of [...this.entries].reverse()) {
          await this.drop(key, entry);
        }
        return null;
      });
      if (waiting === null) return;
      await waiting.wait;
    }
  }
}
