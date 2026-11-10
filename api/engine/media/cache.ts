// One owner for disk publication, deduplication, cleanup and serving leases.
// Network/disk work is never repeated by a retrying database transaction.
import type { Database as Db } from '#engine/store/db.ts';
import {
  type CachedMedia,
  cachedMedia,
  deleteCachedMedia,
  listCachedMedia,
  publishCachedMedia,
  thumbnailVariantCount,
  touchCachedMedia,
} from '#engine/server/media.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { abortable } from '#engine/net/abort.ts';

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
type Pending = {
  run: Promise<CachedMedia>;
  controller: AbortController;
  users: number;
  settled: boolean;
};
export class MediaCache {
  private lane: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private variants = new Map<string, Set<string>>();
  private leases = new Map<string, number>();
  private controller = new AbortController();
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly directory: string;
  constructor(private db: Db, root: string, private maxVariants = 32) {
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
    await Promise.allSettled(
      [...this.pending.values()].map((entry) => entry.run),
    );
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
    signal?: AbortSignal,
  ): Promise<CachedMedia> {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new Error('invalid media concurrency');
    }
    const key = await mediaCacheKey(id);
    signal?.throwIfAborted();
    const prior = this.pending.get(key);
    if (prior) {
      if (prior.controller.signal.aborted) {
        await abortable(signal, () => prior.run.catch(() => {}));
        return await this.fetch(id, maxConcurrent, producer, signal);
      }
      return await this.subscribe(prior, signal);
    }
    if (this.pending.size >= Math.max(1, maxConcurrent) * 16) {
      throw new MatrixError(429, 'M_LIMIT_EXCEEDED', 'Media cache busy');
    }
    const controller = new AbortController();
    const run = this.produce(
      key,
      id,
      maxConcurrent,
      producer,
      AbortSignal.any([this.controller.signal, controller.signal]),
    );
    const entry: Pending = { run, controller, users: 0, settled: false };
    this.pending.set(key, entry);
    const settled = () => {
      entry.settled = true;
      if (this.pending.get(key) === entry) this.pending.delete(key);
    };
    void run.then(settled, settled);
    return await this.subscribe(entry, signal);
  }
  private async subscribe(
    entry: Pending,
    signal?: AbortSignal,
  ): Promise<CachedMedia> {
    entry.users++;
    try {
      return await abortable(signal, () => entry.run);
    } finally {
      entry.users--;
      if (entry.users === 0 && !entry.settled) {
        entry.controller.abort(
          new DOMException('No media subscribers', 'AbortError'),
        );
      }
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
    signal: AbortSignal,
  ): Promise<CachedMedia> {
    while (this.active >= maxConcurrent) {
      let wake: (() => void) | undefined;
      try {
        await abortable(signal, () =>
          new Promise<void>((resolve) => {
            wake = resolve;
            this.waiters.push(resolve);
          }));
      } finally {
        if (wake) {
          const at = this.waiters.indexOf(wake);
          if (at >= 0) this.waiters.splice(at, 1);
        }
      }
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    this.active++;
    const stem = key + '-' + crypto.randomUUID();
    const part = this.directory + '/' + stem + '.part';
    const blob = stem + '.blob';
    let file: Deno.FsFile | null = null;
    let renamed = false;
    const media = JSON.stringify([id.origin, id.mediaId]);
    let reservation: Set<string> | undefined;
    try {
      const hit = await this.locked(async () => {
        const hit = await cachedMedia(this.db, key);
        if (hit || id.scope !== 'thumbnail') return hit;
        const reserved = this.variants.get(media) ?? new Set<string>();
        if (
          await thumbnailVariantCount(this.db, id.origin, id.mediaId) +
              reserved.size >= this.maxVariants
        ) {
          throw new MatrixError(
            429,
            'M_LIMIT_EXCEEDED',
            'Thumbnail variant limit reached',
          );
        }
        reserved.add(key);
        this.variants.set(media, reserved);
        reservation = reserved;
        return null;
      });
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
      const meta = await producer(output, signal);
      signal.throwIfAborted();
      if (meta.size !== size) {
        throw new Error('media cache byte count mismatch');
      }
      await file.sync();
      signal.throwIfAborted();
      file.close();
      file = null;
      await Deno.rename(part, this.directory + '/' + blob);
      renamed = true;
      signal.throwIfAborted();
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
      await this.locked(async () => {
        await publishCachedMedia(this.db, row);
        reservation?.delete(key);
      });
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
      reservation?.delete(key);
      if (this.variants.get(media)?.size === 0) this.variants.delete(media);
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
    const active = (p: Retention) =>
      p.maxagedays > 0 || p.unopenedday > 0 || p.maxbytes > 0;
    if (
      policy.maxbytes <= 0 && !active(policy.remote) &&
      !active(policy.thumbnail)
    ) return;
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
