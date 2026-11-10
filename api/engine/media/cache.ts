// One owner for disk publication, deduplication, cleanup and serving leases.
// Network/disk work is never repeated by a retrying database transaction.
import type { Database as Db } from '#engine/store/db.ts';
import {
  type CachedMedia,
  cachedMedia,
  deleteCachedMedia,
  listCachedMedia,
  publishCachedMedia,
  touchCachedMedia,
} from '#engine/server/media.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export type Retention = {
  maxagedays: number;
  unopenedday: number;
  maxbytes: number;
};
export type CachePolicy = {
  maxbytes: number;
  remote: Retention;
  thumbnail: Retention;
};
export type CacheIdentity = {
  origin: string;
  mediaId: string;
  variant: string;
  scope: CachedMedia['scope'];
};
export type ByteMetadata = {
  contentType: string;
  filename: string | null;
  size: number;
};

export async function mediaCacheKey(id: CacheIdentity): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(
      JSON.stringify([id.origin, id.mediaId, id.variant]),
    ),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
const BLOB = /^[a-f0-9]{64}-[a-f0-9-]{36}\.blob$/;
export class MediaCache {
  private lane: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Promise<CachedMedia>>();
  private leases = new Map<string, number>();
  private controller = new AbortController();
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly directory: string;
  constructor(private db: Db, root: string) {
    this.directory = root + '/cache';
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lane.then(fn);
    this.lane = next.catch(() => {});
    return next;
  }
  async start(): Promise<void> {
    await Deno.mkdir(this.directory, { recursive: true });
    const rows = await listCachedMedia(this.db);
    const known = new Set<string>();
    for (const row of rows) {
      if (!BLOB.test(row.blob)) {
        throw new Error('invalid media cache blob identity');
      }
      try {
        const stat = await Deno.lstat(this.directory + '/' + row.blob);
        if (!stat.isFile || stat.size !== row.size) {
          throw new Deno.errors.NotFound();
        }
        known.add(row.blob);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
        await deleteCachedMedia(this.db, row.cache_key);
      }
    }
    for await (const entry of Deno.readDir(this.directory)) {
      if (
        (BLOB.test(entry.name) ||
          /^[a-f0-9]{64}-[a-f0-9-]{36}\.part$/.test(entry.name)) &&
        !known.has(entry.name)
      ) {
        await Deno.remove(this.directory + '/' + entry.name);
      }
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    for (const wake of this.waiters.splice(0)) wake();
    await Promise.allSettled([...this.pending.values()]);
    await this.lane;
  }
  async get(id: CacheIdentity): Promise<CachedMedia | null> {
    return await cachedMedia(this.db, await mediaCacheKey(id));
  }
  async fetch(
    id: CacheIdentity,
    maxConcurrent: number,
    producer: (
      output: WritableStream<Uint8Array>,
      signal: AbortSignal,
    ) => Promise<ByteMetadata>,
  ): Promise<CachedMedia> {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error('invalid media concurrency');
    }
    const key = await mediaCacheKey(id);
    const prior = this.pending.get(key);
    if (prior) return await prior;
    if (this.pending.size >= Math.max(1, maxConcurrent) * 16) {
      throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'Media cache busy');
    }
    const run = this.produce(key, id, maxConcurrent, producer);
    this.pending.set(key, run);
    try {
      return await run;
    } finally {
      if (this.pending.get(key) === run) this.pending.delete(key);
    }
  }
  private async produce(
    key: string,
    id: CacheIdentity,
    maxConcurrent: number,
    producer: (
      output: WritableStream<Uint8Array>,
      signal: AbortSignal,
    ) => Promise<ByteMetadata>,
  ): Promise<CachedMedia> {
    while (this.active >= maxConcurrent) {
      await new Promise<void>((wake) => this.waiters.push(wake));
      this.controller.signal.throwIfAborted();
    }
    this.controller.signal.throwIfAborted();
    this.active++;
    const stem = key + '-' + crypto.randomUUID();
    const part = this.directory + '/' + stem + '.part';
    const blob = stem + '.blob';
    let file: Deno.FsFile | null = null;
    let renamed = false;
    try {
      const hit = await cachedMedia(this.db, key);
      if (hit) return hit;
      file = await Deno.open(part, {
        createNew: true,
        write: true,
        mode: 0o600,
      });
      let size = 0;
      // A producer closes/aborts its stream. Keep the actual file open until
      // validation and fsync are complete; writable.close alone cannot publish.
      const output = new WritableStream<Uint8Array>({
        async write(chunk) {
          let offset = 0;
          while (offset < chunk.length) {
            const n = await file!.write(chunk.subarray(offset));
            if (n <= 0) throw new Error('short cache write');
            offset += n;
          }
          size += chunk.length;
        },
      });
      const meta = await producer(output, this.controller.signal);
      this.controller.signal.throwIfAborted();
      if (meta.size !== size) {
        throw new Error('media cache byte count mismatch');
      }
      await file.sync();
      file.close();
      file = null;
      await Deno.rename(part, this.directory + '/' + blob);
      renamed = true;
      const now = Date.now();
      const row: CachedMedia = {
        cache_key: key,
        origin: id.origin,
        media_id: id.mediaId,
        variant: id.variant,
        scope: id.scope,
        blob,
        size,
        content_type: meta.contentType,
        filename: meta.filename,
        created_ms: now,
        accessed_ms: now,
      };
      await this.locked(() => publishCachedMedia(this.db, row));
      return row;
    } catch (error) {
      file?.close();
      await Deno.remove(renamed ? this.directory + '/' + blob : part).catch(
        (e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        },
      );
      throw error;
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
  async open(row: CachedMedia): Promise<ReadableStream<Uint8Array>> {
    return await this.locked(async () => {
      const current = await cachedMedia(this.db, row.cache_key);
      if (current?.blob !== row.blob) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'Media evicted');
      }
      if (!BLOB.test(row.blob)) {
        throw new Error('invalid media cache blob identity');
      }
      const file = await Deno.open(this.directory + '/' + row.blob, {
        read: true,
      });
      this.leases.set(row.blob, (this.leases.get(row.blob) ?? 0) + 1);
      try {
        await touchCachedMedia(this.db, row.cache_key, Date.now());
      } catch (error) {
        file.close();
        this.release(row.blob);
        throw error;
      }
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          file.close();
          this.release(row.blob);
        }
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = new Uint8Array(16384);
            const n = await file.read(chunk);
            if (n === null) {
              close();
              controller.close();
            } else controller.enqueue(chunk.subarray(0, n));
          } catch (error) {
            close();
            controller.error(error);
          }
        },
        cancel: close,
      });
    });
  }
  private release(blob: string) {
    const n = (this.leases.get(blob) ?? 1) - 1;
    if (n) this.leases.set(blob, n);
    else this.leases.delete(blob);
  }
  async cleanup(policy: CachePolicy, now = Date.now()): Promise<void> {
    await this.locked(async () => {
      const rows = await listCachedMedia(this.db);
      let total = rows.reduce((n, r) => n + r.size, 0);
      const scopes = { remote: 0, thumbnail: 0 };
      for (const row of rows) scopes[row.scope] += row.size;
      for (const row of rows) {
        const p = policy[row.scope];
        const expired = (p.maxagedays > 0 &&
          row.created_ms <= now - p.maxagedays * 86400000) ||
          (p.unopenedday > 0 &&
            row.accessed_ms <= now - p.unopenedday * 86400000);
        const over = (p.maxbytes > 0 && scopes[row.scope] > p.maxbytes) ||
          (policy.maxbytes > 0 && total > policy.maxbytes);
        if ((!expired && !over) || this.leases.has(row.blob)) continue;
        if (!BLOB.test(row.blob)) {
          throw new Error('invalid media cache blob identity');
        }
        // Remove metadata first. A crash leaves only an unreachable orphan.
        await deleteCachedMedia(this.db, row.cache_key);
        await Deno.remove(this.directory + '/' + row.blob).catch((e) => {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
        });
        total -= row.size;
        scopes[row.scope] -= row.size;
      }
    });
  }
}
