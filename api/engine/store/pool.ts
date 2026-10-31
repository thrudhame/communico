// api/engine/store/pool.ts — the open-file pool. One entry per room/tenant
// file; eviction never touches a file in use or one whose gate is paused.
import { join } from '@std/path';
import { createDatabase } from '#engine/store/create.ts';
import { Db } from '#engine/store/db.ts';
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
};

export class Pool {
  private readonly entries = new Map<string, Entry>();
  readonly errors: Error[] = [];
  private readonly sweeper: ReturnType<typeof setInterval>;
  private closed = false;

  constructor(
    private readonly ffi: Turso,
    private readonly root: string,
    private readonly options: PoolOptions,
  ) {
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
    return !entry.db.inUse && !entry.db.gate.stats().closed;
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
    const cutoff = Date.now() - this.options.idleseconds * 1000;
    for (const [key, entry] of this.entries) {
      if (entry.lastUsed < cutoff && this.evictable(entry)) {
        // The timer must not reject unhandled; drop records close failures.
        void this.drop(key, entry);
      }
    }
  }

  private async evictToLimit(): Promise<void> {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.options.maxopenfiles) return;
      if (this.evictable(entry)) await this.drop(key, entry);
    }
  }

  async acquire(
    kind: FileKind,
    id: string,
    options: { create?: boolean } = {},
  ): Promise<Db> {
    if (this.closed) throw new Error('open-file pool is closed');
    const key = await keyFor(id);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      this.entries.delete(key);
      this.entries.set(key, existing);
      return existing.db;
    }
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
      await createDatabase(this.ffi, parent, key, {
        checkpointlogbytes: this.options.checkpointlogbytes,
        schema: (db) => recordId(db, id),
        verify: (db) => checkId(db, id),
      });
    }
    const db = await Db.open(
      this.ffi,
      files.database,
      this.options.checkpointlogbytes,
    );
    try {
      await checkId(db, id);
    } catch (error) {
      await db.close();
      throw error;
    }
    this.entries.set(key, { db, lastUsed: Date.now() });
    await this.evictToLimit();
    return db;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
    for (const [key, entry] of [...this.entries].reverse()) {
      await this.drop(key, entry);
    }
  }
}
