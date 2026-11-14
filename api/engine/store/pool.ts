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
  ensureSchema,
  type SchemaProvider,
} from '#engine/store/create.ts';
import { type Database, Db, operations } from '#engine/store/db.ts';
import type { Turso } from '#engine/store/ffi.ts';
import type { PreparedSnapshot } from '#engine/store/export.ts';
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

export type SnapshotSource = {
  kind: FileKind;
  key: string;
  id: string;
  prepared: PreparedSnapshot;
  release(): Promise<void>;
};

type Admit = <T>(fn: () => Promise<T>) => Promise<T>;

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
  private readonly retained = new Map<string, number>();
  private readonly fileWork = new Map<string, Promise<unknown>>();
  private readonly closeFailures = new Map<string, unknown>();
  private readonly unlinking = new Set<string>();
  private listings = 0;

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

  async isRetired(kind: FileKind, id: string): Promise<boolean> {
    const key = kind + ':' + await keyFor(id);
    return await this.locked(() => this.retiring.has(key));
  }

  // This queue owns metadata only. Native opens, schema work, reads and closes
  // run outside it, reserved by key, lease or physical-incarnation retention.
  private locked<T>(
    fn: () => T & (T extends PromiseLike<unknown> ? never : unknown),
  ): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private notify(): void {
    for (const wake of this.released.splice(0)) wake();
  }

  private changed(): Promise<void> {
    return new Promise<void>((resolve) => this.released.push(resolve));
  }

  // Called only under locked(). A pending file operation never holds the queue
  // needed by unrelated leases, its own completion, or shutdown.
  private startWork<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const task = Promise.resolve().then(fn).finally(() =>
      this.locked(() => {
        this.fileWork.delete(key);
        this.notify();
      })
    );
    this.fileWork.set(key, task);
    return task;
  }

  private async hold(
    key: string,
    accepted = false,
  ): Promise<() => Promise<void>> {
    for (;;) {
      const result = await this.locked(() => {
        if (this.closed && !accepted) {
          throw new Error('open-file pool is closed');
        }
        if (this.unlinking.has(key)) return { wait: this.changed() };
        this.retained.set(key, (this.retained.get(key) ?? 0) + 1);
        let released = false;
        return {
          release: () =>
            this.locked(() => {
              if (released) return;
              released = true;
              const count = this.retained.get(key)! - 1;
              if (count) this.retained.set(key, count);
              else this.retained.delete(key);
              this.notify();
            }),
        };
      });
      if (result.release) return result.release;
      await result.wait;
    }
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

  // Filesystem metadata only: no native open, replay, migration or checkpoint.
  // Store revalidates this inventory at the common admission fence.
  async snapshotInventory(): Promise<{ kind: FileKind; key: string }[]> {
    const result: { kind: FileKind; key: string }[] = [];
    for (const kind of ['tenants', 'rooms'] as const) {
      try {
        for await (const entry of Deno.readDir(join(this.root, kind))) {
          if (!entry.isDirectory || entry.name.endsWith('.new')) continue;
          const path =
            databaseFiles(directory(this.root, kind, entry.name)).database;
          try {
            if (!(await Deno.lstat(path)).isFile) {
              throw new Error('backup source must be a regular database file');
            }
            result.push({ kind, key: entry.name });
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return result.sort((a, b) =>
      (a.kind + a.key).localeCompare(b.kind + b.key)
    );
  }

  // Retain a physical incarnation before opening it. Every native operation is
  // outside metadata admission, so inactive and over-cache sources cannot stall
  // unrelated active writers behind the pool queue. Retirement does not exclude
  // final files: their durable removal intent belongs to the same cut.
  async retainSnapshot(
    kind: FileKind,
    fileKey: string,
  ): Promise<SnapshotSource | undefined> {
    const key = kind + ':' + fileKey;
    const releaseHold = await this.hold(key);
    let db: Db | undefined;
    let prepared: PreparedSnapshot | undefined;
    let releasing: Promise<void> | undefined;
    const release = () =>
      releasing ??= (async () => {
        try {
          try {
            await prepared?.release();
          } finally {
            await db?.close();
          }
        } finally {
          await releaseHold();
        }
      })();
    try {
      const path = databaseFiles(directory(this.root, kind, fileKey)).database;
      if (!(await Deno.lstat(path)).isFile) {
        throw new Error('backup source must be a regular database file');
      }
      db = await Db.open(this.ffi, path, this.options.checkpointlogbytes);
      const rows = await db.query('SELECT value FROM id');
      if (
        rows.length !== 1 || typeof rows[0].value !== 'string' ||
        await keyFor(rows[0].value) !== fileKey
      ) throw new Error('backup source id/path mismatch');
      const id = rows[0].value;
      await ensureSchema(db, this.providers[kind]);
      prepared = await db.prepareReadSnapshot();
      return { kind, key: fileKey, id, prepared, release };
    } catch (error) {
      await release();
      // A deletion can finish between enumeration and retention. The Store
      // enumerates again before pinning; never create a replacement source.
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
  }

  private evictable(entry: Entry): boolean {
    return entry.leases === 0 && !entry.db.inUse &&
      !entry.db.gate.stats().closed;
  }

  private drop(key: string, entry: Entry): Promise<void> {
    this.entries.delete(key);
    const task = this.startWork(key, async () => {
      try {
        await entry.db.close();
      } catch (error) {
        // A failed close does not prove native lifetime ended. Keep its path
        // fenced against reopen/unlink, including when eviction started it.
        this.closeFailures.set(key, error);
        throw error;
      }
    });
    void task.catch((error) => {
      this.errors.push(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
    return task;
  }

  private idleSweep(): void {
    void this.locked(() => {
      if (this.closed) return;
      const cutoff = Date.now() - this.options.idleseconds * 1000;
      for (const [key, entry] of this.entries) {
        if (entry.lastUsed < cutoff && this.evictable(entry)) {
          this.drop(key, entry);
        }
      }
    }).catch((error) =>
      this.errors.push(
        error instanceof Error ? error : new Error(String(error)),
      )
    );
  }

  private evictToLimit(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxopenfiles) return;
      if (this.evictable(entry) && !this.fileWork.has(key)) {
        this.drop(key, entry);
      }
    }
  }

  // The ids recorded on disk for one kind (the server stage's startup
  // discovery): every directory's file is opened, its id row read, then
  // released. Files already pooled stay pooled (the open dedups by path).
  async list(kind: FileKind): Promise<string[]> {
    if (this.closed) throw new Error('open-file pool is closed');
    this.listings++;
    try {
      return await this.listFiles(kind);
    } finally {
      await this.locked(() => {
        this.listings--;
        this.notify();
      });
    }
  }

  private async listFiles(kind: FileKind): Promise<string[]> {
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
      const releaseHold = await this.hold(kind + ':' + entry.name, true);
      try {
        const files = databaseFiles(directory(this.root, kind, entry.name));
        try {
          if (!(await Deno.stat(files.database)).isFile) {
            throw new Error(`not a database file: ${files.database}`);
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
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
      } finally {
        await releaseHold();
      }
    }
    return ids;
  }

  // Initialize before safe-create publishes the file. The callback cannot
  // expose the staged handle; on rejection the store removes its own stage.
  async initialize<T>(
    kind: FileKind,
    id: string,
    fn: (db: Database) => Promise<T>,
  ): Promise<T> {
    const key = kind + ':' + await keyFor(id);
    for (;;) {
      const result = await this.locked(() => {
        if (this.closed) throw new Error('open-file pool is closed');
        if (this.removing.has(key) || this.retiring.has(key)) {
          throw new Deno.errors.NotFound(`removed ${kind} database: ${id}`);
        }
        const waiting = this.fileWork.get(key);
        if (waiting) return { wait: waiting };
        return {
          work: this.startWork(key, () => this.initializeFile(kind, id, fn)),
        };
      });
      if (result.work) return await result.work;
      // Another operation's failure does not determine this caller's result.
      await result.wait?.catch(() => undefined);
    }
  }

  private async initializeFile<T>(
    kind: FileKind,
    id: string,
    fn: (db: Database) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new Error('open-file pool is closed');
    const parent = join(this.root, kind);
    const key = await keyFor(id);
    const identity = kind + ':' + key;
    if (this.removing.has(identity) || this.retiring.has(identity)) {
      throw new Deno.errors.NotFound(`removed ${kind} database: ${id}`);
    }
    const provider = this.providers[kind];
    await Deno.mkdir(parent, { recursive: true });
    let result!: T;
    await createDatabase(this.ffi, parent, key, {
      checkpointlogbytes: this.options.checkpointlogbytes,
      discardOnFailure: true,
      schema: async (db) => {
        await recordId(db, id);
        await applySchema(db, provider);
        result = await fn(db);
      },
      verify: async (db) => {
        await checkId(db, id);
        await checkSchema(db, provider);
      },
    });
    return result;
  }

  async acquire(
    kind: FileKind,
    id: string,
    options: { create?: boolean; incarnation?: symbol } = {},
  ): Promise<Lease> {
    const fileKey = await keyFor(id);
    const key = kind + ':' + fileKey;
    for (;;) {
      const result = await this.locked(() => {
        if (this.closed) throw new Error('open-file pool is closed');
        const previous = this.incarnations.get(key);
        if (this.closeFailures.has(key)) throw this.closeFailures.get(key);
        if (
          this.removing.has(key) || this.retiring.has(key) ||
          (options.incarnation !== undefined &&
            options.incarnation !== previous)
        ) {
          throw new Deno.errors.NotFound(`removed ${kind} database: ${id}`);
        }
        const entry = this.entries.get(key);
        if (entry) return { lease: this.lease(key, entry) };
        const waiting = this.fileWork.get(key);
        if (waiting) return { wait: waiting };
        return {
          opening: this.startWork(key, async () => {
            const db = await this.open(kind, id, fileKey, options);
            let accepted = false;
            try {
              return await this.locked(() => {
                if (this.closed) throw new Error('open-file pool is closed');
                if (
                  this.removing.has(key) || this.retiring.has(key) ||
                  this.incarnations.get(key) !== previous
                ) {
                  throw new Deno.errors.NotFound(
                    `removed ${kind} database: ${id}`,
                  );
                }
                const lease = this.lease(key, {
                  db,
                  leases: 0,
                  lastUsed: Date.now(),
                });
                accepted = true;
                return lease;
              });
            } finally {
              if (!accepted) await db.close();
            }
          }),
        };
      });
      if (result.lease) return result.lease;
      if (result.opening) return await result.opening;
      await result.wait?.catch(() => undefined);
    }
  }

  private lease(key: string, entry: Entry): Lease {
    // Failed opens must not retain attacker-selected identities. Existing
    // tokens survive eviction and every failure so held handles keep their
    // retirement fence; publish a first token only after open succeeds.
    const incarnation = this.incarnations.get(key) ?? Symbol();
    this.incarnations.set(key, incarnation);
    entry.leases++;
    entry.lastUsed = Date.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.evictToLimit();
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
        await this.locked(() => {
          leased.leases--;
          leased.lastUsed = Date.now();
          this.evictToLimit();
          this.notify();
        });
      },
    };
  }

  /** Retire this file incarnation, drain leases, close, then unlink its directory.
   * Metadata waits never hold the queue needed by lease.release(). */
  async remove(
    kind: FileKind,
    id: string,
    admit: Admit = (fn) => fn(),
  ): Promise<void> {
    const fileKey = await keyFor(id);
    const key = kind + ':' + fileKey;
    await admit(() =>
      this.locked(() => {
        if (this.closed) throw new Error('open-file pool is closed');
        if (this.removing.has(key)) {
          throw new Error(`removal already in progress: ${id}`);
        }
        this.removing.add(key);
        this.retireKey(key);
      })
    );
    try {
      for (;;) {
        const waiting = await this.locked(() => {
          if (this.closeFailures.has(key)) throw this.closeFailures.get(key);
          const entry = this.entries.get(key);
          if (
            (entry !== undefined && entry.leases > 0) ||
            this.retained.has(key) || this.fileWork.has(key)
          ) {
            return {
              wait: this.changed(),
            };
          }
          if (entry !== undefined) {
            return { wait: this.drop(key, entry) };
          }
          this.unlinking.add(key);
          return null;
        });
        if (waiting) {
          await waiting.wait;
          continue;
        }
        await admit(async () => {
          try {
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
            await this.locked(() => this.retiring.delete(key));
          } finally {
            await this.locked(() => {
              this.unlinking.delete(key);
              this.notify();
            });
          }
        });
        return;
      }
    } finally {
      await admit(() =>
        this.locked(() => {
          this.removing.delete(key);
          this.notify();
        })
      );
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
      await ensureSchema(db, this.providers[kind]);
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
      const waiting = await this.locked(() => {
        if (
          this.retained.size || this.fileWork.size || this.removing.size ||
          this.listings ||
          [...this.entries.values()].some((entry) => entry.leases > 0)
        ) {
          return {
            wait: this.changed(),
          };
        }
        for (const [key, entry] of [...this.entries].reverse()) {
          this.drop(key, entry);
        }
        if (!this.fileWork.size && this.closeFailures.size) {
          throw new AggregateError(
            [...this.closeFailures.values()],
            'file close failed',
          );
        }
        return this.fileWork.size ? { wait: this.changed() } : null;
      });
      if (waiting === null) return;
      await waiting.wait;
    }
  }
}
