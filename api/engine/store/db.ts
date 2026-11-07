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
import { databaseFiles } from '#engine/store/layout.ts';

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

export class Conn {
  private active = true;

  constructor(private readonly ffi: Turso, private readonly handle: number) {}

  private check(): void {
    if (!this.active) {
      throw new Error('transaction connection has been released');
    }
  }

  query(sql: string, values: readonly Value[] = []): Promise<Row[]> {
    this.check();
    return this.ffi.query(this.handle, sql, values);
  }

  execute(sql: string, values: readonly Value[] = []): Promise<number> {
    this.check();
    return this.ffi.execute(this.handle, sql, values);
  }

  exec(sql: string): Promise<void> {
    this.check();
    return this.ffi.exec(this.handle, sql);
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
    options?: { mode?: BeginMode },
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
  ) {
    this.gate = new Gate(path, checkpointlogbytes, async (started) => {
      const connection = await this.acquire();
      try {
        const result = this.ffi.checkpoint(connection, 'TRUNCATE');
        started();
        return await result;
      } finally {
        this.idle.push(connection);
        this.notify();
      }
    });
  }

  static async open(
    ffi: Turso,
    path: string,
    checkpointlogbytes: number,
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
        return await this.open(ffi, path, checkpointlogbytes);
      }
      if (
        db.ffi !== ffi || db.gate.threshold !== checkpointlogbytes
      ) {
        throw new Error('database already owned by another library');
      }
      db.references++;
      return db;
    }
    const opened = ffi.open(path).then((handle) =>
      new Db(ffi, path, handle, checkpointlogbytes)
    );
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
          return await this.ffi.connect(this.handle);
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
  // Only native write-write/busy conflicts retry, after a successful rollback.
  async tx<T>(
    fn: (connection: Conn) => Promise<T>,
    options: { mode?: BeginMode } = {},
  ): Promise<T> {
    if (this.closing || this.closed) {
      throw new Error('database is closing or closed');
    }
    this.users++;
    try {
      for (let attempt = 1;; attempt++) {
        const result = await this.attempt(fn, options.mode ?? 'concurrent');
        if (result.committed) return result.value;
        this.conflictCounters.conflicts++;
        if (attempt === TRANSACTION_ATTEMPTS) {
          this.conflictCounters.exhausted++;
          throw new StoreConflictError(this.path, attempt, result.error);
        }
        this.conflictCounters.retries++;
        // Equal jitter avoids synchronized writers and caps every wait at 50ms.
        const cap = Math.min(50, 2 ** (attempt - 1));
        const started = performance.now();
        await new Promise((wake) =>
          setTimeout(wake, cap / 2 + Math.random() * cap / 2)
        );
        this.conflictCounters.backoffMs += performance.now() - started;
      }
    } finally {
      this.users--;
      this.notify();
    }
  }

  private async attempt<T>(
    fn: (connection: Conn) => Promise<T>,
    mode: BeginMode,
  ): Promise<
    { committed: true; value: T } | { committed: false; error: StoreError }
  > {
    await this.gate.enter();
    let handle: number | undefined;
    let connection: Conn | undefined;
    let reusable = true;
    let committed = false;
    try {
      handle = await this.acquire();
      connection = new Conn(this.ffi, handle);
      try {
        await this.ffi.begin(handle, mode);
        const result = await fn(connection);
        await this.ffi.commit(handle);
        committed = true;
        return { committed: true, value: result };
      } catch (error) {
        try {
          await this.ffi.rollback(handle);
        } catch (rollback) {
          reusable = false;
          throw new AggregateError(
            [error, rollback],
            'transaction and rollback failed',
          );
        }
        if (error instanceof StoreError && error.conflict) {
          return { committed: false, error };
        }
        throw error;
      }
    } finally {
      connection?.release();
      try {
        if (handle !== undefined) {
          if (reusable) this.idle.push(handle);
          else {
            try {
              await this.ffi.closeConnection(handle);
            } finally {
              this.connections--;
            }
          }
        }
      } finally {
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
    await this.ffi.closeFile(this.handle);
    this.closed = true;
    Db.openFiles.delete(this.path);
  }
}
