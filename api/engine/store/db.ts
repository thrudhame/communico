// api/engine/store/db.ts — one owner per canonical file, at most eight native
// connections. A Conn is a transaction-scoped capability, never a shared cursor.
import { basename, dirname, join, resolve } from '@std/path';
import {
  type BeginMode,
  type Row,
  StoreError,
  Turso,
  type Value,
} from '#engine/store/ffi.ts';
import { Gate } from '#engine/store/gate.ts';
import {
  isStoragePressure,
  StorageBusyError,
  storageFailure,
  StoragePressureError,
} from '#engine/store/pressure.ts';
import {
  storageHeld,
  storageScope,
  withStorageHold,
} from '#engine/store/holds.ts';
import { commitAdmitted, type CommitCheck } from '#engine/store/commit.ts';
import type { Admission } from '#engine/store/admission.ts';
import type { Capacity, NativeReservation } from '#engine/store/capacity.ts';
import { databaseFiles } from '#engine/store/layout.ts';
import { publish } from '#engine/store/files.ts';
import {
  exportSnapshot,
  type PreparedSnapshot,
  type ReadSnapshot,
} from '#engine/store/export.ts';

export class StoreConflictError extends StoreError {
  constructor(
    readonly path: string,
    readonly attempts: number,
    cause: StoreError,
  ) {
    super(
      cause.code,
      `write conflict after ${attempts} attempts: ${path}`,
      cause.lastError,
    );
    this.name = 'StoreConflictError';
    this.cause = cause;
  }
}

export type ConflictStats = {
  conflicts: number;
  retries: number;
  exhausted: number;
  backoffMs: number;
};

const TRANSACTION_ATTEMPTS = 20;
const NO_GROWTH = { blockSize: 1, bytes: 0 };

class DeferNativeWrite extends Error {}

type Attempt<T> =
  | { kind: 'committed'; value: T }
  | { kind: 'retry'; error: StoreError | StoragePressureError }
  | { kind: 'deferred' };

export class Conn {
  private active = true;
  private writeVersion = 0;

  constructor(
    private readonly ffi: Turso,
    private readonly handle: number,
    private readonly checks = new Set<CommitCheck>(),
    private readonly beginWrite: () => void | Promise<void> = () => {},
    private readonly observeScratch?: () => Promise<unknown> | undefined,
  ) {}

  /** Retain a dependency for this attempt's actual native commit. */
  admit(check: CommitCheck): void {
    this.check();
    check();
    this.checks.add(check);
  }

  private check(): void {
    if (!this.active) {
      throw new Error('transaction connection has been released');
    }
  }

  query(sql: string, values: readonly Value[] = []): Promise<Row[]> {
    this.check();
    // query also accepts row-producing writes (for example RETURNING).
    // WITH can lead to a SELECT or DML. Err toward a write for any ambiguous
    // statement (including keywords inside strings/comments).
    const readOnly = /^\s*(SELECT|WITH)\b[^;]*;?\s*$/is.test(sql) &&
      !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(sql);
    const query = () => this.ffi.query(this.handle, sql, values);
    return readOnly ? this.statement(query) : this.write(query);
  }

  /** Successful affected-row writes in this attempt, not global database work.
   * Owner adapters use this to distinguish an empty mutation from retained work. */
  get writes(): number {
    this.check();
    return this.writeVersion;
  }

  execute(sql: string, values: readonly Value[] = []): Promise<number> {
    this.check();
    return this.write(() => this.ffi.execute(this.handle, sql, values)).then(
      (affected) => {
        if (affected > 0) this.writeVersion++;
        return affected;
      },
    );
  }

  exec(sql: string): Promise<void> {
    this.check();
    return this.write(() => this.ffi.exec(this.handle, sql));
  }

  private write<T>(run: () => Promise<T>): Promise<T> {
    const admitted = this.beginWrite();
    return admitted
      ? admitted.then(() => this.statement(run))
      : this.statement(run);
  }

  private statement<T>(run: () => Promise<T>): Promise<T> {
    const result = run();
    const observe = this.observeScratch;
    return observe ? result.finally(() => observe()?.catch(() => {})) : result;
  }

  release(): void {
    this.active = false;
  }
}

// A logical database capability, safe to retain. Its owner acquires the
// physical file for each operation; only the storage layer owns raw Dbs.
export interface Database {
  readonly path: string;
  tx<T>(
    fn: (connection: Conn) => Promise<T>,
    options?: { mode?: BeginMode; admit?: CommitCheck },
  ): Promise<T>;
  query(sql: string, values?: readonly Value[]): Promise<Row[]>;
  execute(sql: string, values?: readonly Value[]): Promise<number>;
  exec(sql: string): Promise<void>;
}

export function operations(tx: Database['tx'], path: string): Database {
  return {
    path,
    tx,
    query: (sql, values = []) => tx((conn) => conn.query(sql, values)),
    execute: (sql, values = []) => tx((conn) => conn.execute(sql, values)),
    exec: (sql) => tx((conn) => conn.exec(sql), { mode: 'deferred' }),
  };
}

export class Db {
  readonly gate: Gate;
  private readonly lifetime = crypto.randomUUID();
  private revision = 0n;
  private writers = 0;

  /** A process/open-file lifetime and commit revision, not a durable cursor. */
  get stableRevision(): string | undefined {
    if (this.closing || this.closed || this.writers !== 0) return undefined;
    return `${this.lifetime}:${this.revision}`;
  }
  private static readonly openFiles = new Map<string, Promise<Db>>();
  private idle: number[] = [];
  private connections = 0;
  private users = 0;
  private references = 1;
  private closing = false;
  private closed = false;
  private closingTask?: Promise<void>;
  private waiters: (() => void)[] = [];
  private readonly conflictCounters: ConflictStats = {
    conflicts: 0,
    retries: 0,
    exhausted: 0,
    backoffMs: 0,
  };

  private constructor(
    readonly ffi: Turso,
    readonly path: string,
    private readonly handle: number,
    checkpointlogbytes: number,
    private readonly admission?: Admission,
    private readonly capacity?: Capacity,
    private readonly privateDatabase = false,
  ) {
    this.gate = new Gate(path, checkpointlogbytes, async (started) => {
      if (this.capacity && this.privateDatabase) {
        // A staging database has no owned-checkpoint exception. Its journal
        // is part of the private tree and can survive until publication.
        return;
      }
      const lease = await this.capacity?.tryCheckpoint(path);
      if (this.capacity && !lease) return;
      let outcome: 'full' | 'completed' | undefined;
      let connection: number | undefined;
      let reusable = true;
      try {
        connection = await this.acquire();
        if (!lease) {
          const result = this.ffi.checkpoint(connection, 'TRUNCATE');
          started();
          return await result;
        }
        const result = this.ffi.ownedCheckpoint(connection);
        started();
        const { rows, error, peakBytes } = await result;
        lease.observe(peakBytes);
        if (error) {
          const failure = new StoreError(
            error.code,
            error.message,
            error.lastError,
          );
          if (failure.storageFull) outcome = 'full';
          try {
            await this.ffi.rollback(connection, true);
          } catch (rollback) {
            reusable = false;
            if (!failure.storageFull) {
              throw new AggregateError(
                [failure, rollback],
                'checkpoint and rollback failed',
              );
            }
          }
          // COMMIT already succeeded: ENOSPC in maintenance must neither
          // replay the transaction nor report its confirmed write as refused.
          if (failure.storageFull) return;
          throw failure;
        }
        if (!rows.some((row) => Number(row.busy ?? 0) !== 0)) {
          outcome = 'completed';
        }
        return rows;
      } finally {
        try {
          if (connection !== undefined) {
            if (reusable) this.idle.push(connection);
            else {
              this.connections--;
              await this.ffi.closeConnection(connection, true);
            }
          }
        } finally {
          lease?.finish(outcome);
          await this.capacity?.observeScratch()?.catch(() => {});
          this.notify();
        }
      }
    });
  }

  static async open(
    ffi: Turso,
    path: string,
    checkpointlogbytes: number,
    admission?: Admission,
    capacity?: Capacity,
    privateDatabase = false,
  ): Promise<Db> {
    path = resolve(path);
    if (path !== databaseFiles(dirname(path)).database) {
      throw new Error('database file must be named data.db');
    }
    try {
      path = await Deno.realPath(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      path = join(await Deno.realPath(dirname(path)), basename(path));
    }
    const existing = this.openFiles.get(path);
    if (existing) {
      const db = await existing;
      if (db.closingTask !== undefined) {
        await db.closingTask;
        return await this.open(
          ffi,
          path,
          checkpointlogbytes,
          admission,
          capacity,
          privateDatabase,
        );
      }
      if (
        db.ffi !== ffi || db.gate.threshold !== checkpointlogbytes ||
        db.privateDatabase !== privateDatabase ||
        (admission !== undefined && db.admission !== admission) ||
        (capacity !== undefined && db.capacity !== capacity)
      ) {
        throw new Error('database already owned by another library');
      }
      db.references++;
      return db;
    }
    const opened = (async () => {
      // Bootstrap may create the database, logical log and WAL. Hold the
      // shared grant before native initialization can touch any of them.
      const lease = await capacity?.reserveNative(path, 3);
      try {
        return await ffi.open(path, lease);
      } catch (error) {
        throw storageFailure(error);
      } finally {
        lease?.release();
      }
    })().then(async (handle) => {
      const db = new Db(
        ffi,
        path,
        handle,
        checkpointlogbytes,
        admission,
        capacity,
        privateDatabase,
      );
      try {
        const connection = await db.acquire();
        try {
          // File admission owns checkpoints. Native auto-checkpoint runs inside
          // COMMIT, before the gate can drain peers, and makes unrelated begins
          // exhaust their conflict retries while maintenance holds its lock.
          await ffi.query(connection, 'PRAGMA mvcc_checkpoint_threshold=-1');
        } finally {
          db.idle.push(connection);
        }
        return db;
      } catch (error) {
        await db.shutdown();
        throw error;
      }
    });
    this.openFiles.set(path, opened);
    try {
      return await opened;
    } catch (error) {
      this.openFiles.delete(path);
      throw error;
    }
  }

  get inUse(): boolean {
    return this.users > 0;
  }

  private notify(): void {
    for (const wake of this.waiters.splice(0)) wake();
  }

  private async acquire(): Promise<number> {
    for (;;) {
      const connection = this.idle.pop();
      if (connection !== undefined) return connection;
      if (this.connections < 8) {
        this.connections++;
        try {
          return await this.ffi.connect(this.handle, !!this.capacity);
        } catch (error) {
          this.connections--;
          this.notify();
          throw error;
        }
      }
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
  }

  conflictStats(): ConflictStats {
    return { ...this.conflictCounters };
  }

  // A body may run more than once. Use only its Conn and attempt-local
  // values; never perform network I/O, notify listeners, or mutate captured
  // state. Return effects as values and publish them only after tx resolves.
  // Native conflicts and temporarily held capacity retry after rollback. A
  // managed transaction waiting for a grant owns neither slot nor file gate.
  async tx<T>(
    fn: (connection: Conn) => Promise<T>,
    options: { mode?: BeginMode; admit?: CommitCheck } = {},
  ): Promise<T> {
    if (this.closing || this.closed) {
      throw new Error('database is closing or closed');
    }
    this.users++;
    const held = this.capacity !== undefined && storageHeld();
    try {
      for (let attempt = 1, deferred = false;;) {
        const result = await (this.capacity
          ? storageScope(async () => {
            const grant = deferred
              ? await this.capacity!.reserveNative(this.path, 2)
              : undefined;
            try {
              return await withStorageHold(() =>
                this.attempt(fn, options, grant, !held)
              );
            } finally {
              // The attempt normally releases before leaving its file gate;
              // also cover failure before the attempt could enter the gate.
              grant?.release();
            }
          })
          : this.attempt(fn, options));
        if (result.kind === 'committed') return result.value;
        deferred = result.kind === 'deferred';
        if (result.kind === 'deferred') continue;
        const error = result.error;
        if (held && error instanceof StorageBusyError) throw error;
        if (
          error instanceof StoragePressureError &&
          !(error instanceof StorageBusyError)
        ) {
          if (
            attempt < TRANSACTION_ATTEMPTS &&
            await this.capacity?.reclaimAfterFull(this.path)
          ) continue;
          throw error;
        }
        if (error instanceof StoreError) this.conflictCounters.conflicts++;
        if (attempt === TRANSACTION_ATTEMPTS) {
          if (error instanceof StorageBusyError) throw error;
          this.conflictCounters.exhausted++;
          throw new StoreConflictError(this.path, attempt, error);
        }
        if (error instanceof StoreError) this.conflictCounters.retries++;
        // Equal jitter avoids synchronized writers and caps every wait at 50ms.
        const cap = Math.min(50, 2 ** (attempt - 1));
        const started = performance.now();
        await new Promise((wake) =>
          setTimeout(wake, cap / 2 + Math.random() * cap / 2)
        );
        if (error instanceof StoreError) {
          this.conflictCounters.backoffMs += performance.now() - started;
        }
        attempt++;
      }
    } finally {
      this.users--;
      this.notify();
    }
  }

  private async attempt<T>(
    fn: (connection: Conn) => Promise<T>,
    options: { mode?: BeginMode; admit?: CommitCheck },
    grant?: NativeReservation,
    canDefer = false,
  ): Promise<Attempt<T>> {
    await this.gate.enter();
    let handle: number | undefined;
    let connection: Conn | undefined;
    let reusable = true;
    let committed = false;
    let writing = false;
    let lease = grant;
    let admission: Promise<void> | undefined;
    try {
      handle = await this.acquire();
      const checks = new Set<CommitCheck>();
      connection = new Conn(this.ffi, handle, checks, () => {
        if (!writing) {
          writing = true;
          this.writers++;
        }
        // A read-only attempt starts (and ends) under a zero-growth guard.
        // Only a write-capable statement can take the rest of the envelope.
        if (this.capacity) {
          return admission ??= (async () => {
            try {
              lease ??= await this.capacity!.tryReserveNative(this.path, 2);
            } catch (error) {
              if (canDefer && error instanceof StorageBusyError) {
                throw new DeferNativeWrite();
              }
              throw error;
            }
            // Keep a separate pool for rollback/destruction. In particular,
            // a failed commit cannot consume the last of its own grant.
            const undo = Math.ceil(lease.bytes / lease.blockSize / 2) *
              lease.blockSize;
            await this.ffi.setLimit(handle!, lease, undo);
          })();
        }
      }, this.capacity && (() => this.capacity!.observeScratch()));
      try {
        await this.ffi.begin(handle, options.mode ?? 'concurrent');
        if (options.admit) connection.admit(options.admit);
        const result = await fn(connection);
        // A body cannot turn a refused first write into a successful commit
        // by handling its statement error locally.
        await admission;
        const commit = () =>
          commitAdmitted(checks, () => this.ffi.commit(handle!));
        if (this.admission) {
          await this.admission.run(commit);
        } else {
          await commit();
        }
        if (writing) this.revision++;
        committed = true;
        return { kind: 'committed', value: result };
      } catch (error) {
        try {
          await this.ffi.rollback(handle);
        } catch (rollback) {
          reusable = false;
          const failure = new AggregateError(
            [error, rollback],
            'transaction and rollback failed',
          );
          throw isStoragePressure(error)
            ? new StoragePressureError(failure)
            : failure;
        }
        if (error instanceof DeferNativeWrite) return { kind: 'deferred' };
        if (
          error instanceof StorageBusyError ||
          (error instanceof StoreError && error.conflict)
        ) {
          return { kind: 'retry', error };
        }
        if (this.capacity && error instanceof StoreError && error.storageFull) {
          // Only retry a native full outcome known to have rolled back, never
          // a failure reported by maintenance after a successful COMMIT.
          return { kind: 'retry', error: new StoragePressureError(error) };
        }
        throw storageFailure(error);
      }
    } finally {
      if (writing) this.writers--;
      connection?.release();
      try {
        if (handle !== undefined) {
          if (reusable) {
            try {
              if (lease) await this.ffi.setLimit(handle, NO_GROWTH, 0);
              this.idle.push(handle);
              handle = undefined;
            } finally {
              if (handle !== undefined) {
                this.connections--;
                await this.ffi.closeConnection(handle);
              }
            }
          } else {
            try {
              await this.ffi.closeConnection(handle);
            } finally {
              this.connections--;
            }
          }
        }
      } finally {
        lease?.release();
        this.notify();
        // Maintenance errors after COMMIT must never replay a committed body.
        await this.gate.leave(committed);
      }
    }
  }

  query(sql: string, values: readonly Value[] = []): Promise<Row[]> {
    return this.tx((connection) => connection.query(sql, values));
  }

  execute(sql: string, values: readonly Value[] = []): Promise<number> {
    return this.tx((connection) => connection.execute(sql, values));
  }

  exec(sql: string): Promise<void> {
    return this.tx((connection) => connection.exec(sql), { mode: 'deferred' });
  }

  // Separate maintenance capability: owns one native read transaction without
  // consuming an ordinary transaction slot or blocking threshold writers.
  async readSnapshot(): Promise<ReadSnapshot> {
    const prepared = await this.prepareReadSnapshot();
    return await prepared.pin();
  }

  // Connect and drain existing checkpoints before the whole-store fence. Only
  // BEGIN and its first metadata read belong inside the common cut.
  async prepareReadSnapshot(): Promise<PreparedSnapshot> {
    if (this.closing || this.closed) {
      throw new Error('database is closing or closed');
    }
    this.users++;
    let releaseGate: (() => void) | undefined;
    let handle: number | undefined;
    let released = false;
    let exporting: Promise<void> | undefined;
    let releasing: Promise<void> | undefined;
    let pinned = false;
    const release = () =>
      releasing ??= (async () => {
        released = true;
        try {
          await exporting?.catch(() => undefined);
          if (handle !== undefined) {
            try {
              await this.ffi.rollback(handle);
            } finally {
              await this.ffi.closeConnection(handle);
            }
          }
        } finally {
          releaseGate?.();
          this.users--;
          this.notify();
        }
      })();
    try {
      releaseGate = await this.gate.retain();
      handle = await this.ffi.connect(this.handle, !!this.capacity);
      return {
        pin: async () => {
          if (released || pinned) {
            throw new Error('snapshot is released or already pinned');
          }
          pinned = true;
          try {
            await this.ffi.begin(handle!, 'deferred');
            // BEGIN alone is lazy; this read establishes the actual MVCC cut.
            const schema = await this.ffi.query(
              handle!,
              'SELECT type,name,sql FROM sqlite_schema ORDER BY rowid',
            );
            return {
              export: (destination) => {
                if (released) {
                  return Promise.reject(
                    new Error('snapshot has been released'),
                  );
                }
                if (exporting) {
                  return Promise.reject(
                    new Error('snapshot export already started'),
                  );
                }
                if (resolve(destination) === this.path) {
                  return Promise.reject(
                    new TypeError('backup destination is the source database'),
                  );
                }
                return exporting = withStorageHold(() =>
                  exportSnapshot(
                    this.ffi,
                    handle!,
                    schema,
                    destination,
                    this.capacity,
                    dirname(dirname(this.path)),
                  )
                );
              },
              release,
            };
          } catch (error) {
            await release();
            throw error;
          }
        },
        release,
      };
    } catch (error) {
      try {
        await release();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          'snapshot pin and release failed',
        );
      }
      throw error;
    }
  }

  // Store-owned maintenance, deliberately absent from the logical Database/Conn
  // capability. The gate retains this reader against checkpoint and shutdown.
  async vacuumInto(destination: string): Promise<void> {
    if (this.closing || this.closed) {
      throw new Error('database is closing or closed');
    }
    if (resolve(destination) === this.path) {
      throw new TypeError('backup destination is the source database');
    }
    if (this.capacity) {
      // Managed backups use the logical writer, whose target runs through
      // the same observed IO as our ordinary databases.
      const reader = await this.readSnapshot();
      try {
        await reader.export(destination);
      } finally {
        await reader.release();
      }
      return;
    }
    this.users++;
    let entered = false;
    let handle: number | undefined;
    let staging: string | undefined;
    try {
      await this.gate.enter();
      entered = true;
      handle = await this.acquire();
      staging = await Deno.makeTempDir({
        dir: dirname(dirname(this.path)),
        prefix: '.backup-',
        suffix: '.new',
      });
      await this.ffi.vacuumInto(handle, staging);
      const output = join(staging, 'data.db');
      await Deno.chmod(output, 0o600);
      await publish(this.ffi, output, destination);
    } finally {
      try {
        if (handle !== undefined) {
          try {
            await this.ffi.rollback(handle);
          } finally {
            try {
              await this.ffi.closeConnection(handle);
            } finally {
              this.connections--;
            }
          }
        }
      } finally {
        try {
          try {
            if (staging !== undefined) {
              await Deno.remove(staging, { recursive: true });
            }
          } finally {
            if (entered) await this.gate.leave(false);
          }
        } finally {
          this.users--;
          this.notify();
        }
      }
    }
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.closingTask) return this.closingTask;
    if (this.references > 1) {
      this.references--;
      return Promise.resolve();
    }
    this.closing = true;
    this.closingTask = this.shutdown();
    return this.closingTask;
  }

  private async shutdown(): Promise<void> {
    while (this.users) {
      await new Promise<void>((wake) => this.waiters.push(wake));
    }
    while (this.idle.length) {
      await this.ffi.closeConnection(this.idle[this.idle.length - 1]);
      this.idle.pop();
      this.connections--;
    }
    await this.ffi.closeFile(this.handle, !!this.capacity);
    this.closed = true;
    Db.openFiles.delete(this.path);
  }
}
