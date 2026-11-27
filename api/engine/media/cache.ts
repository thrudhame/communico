// One owner for disk publication, deduplication, cleanup and serving leases.
// Network/disk work is never repeated by a retrying database transaction.
import type { Database as Db } from '#engine/store/db.ts';
import type { Capacity, Reservation } from '#engine/store/capacity.ts';
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
import { isStoragePressure, storageFailure } from '#engine/store/pressure.ts';
import { withStorageHold } from '#engine/store/holds.ts';
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
  private registered = new Map<string, { row: CachedMedia; forget(): void }>();
  private canonicalDirectory?: string;
  private controller = new AbortController();
  private active = 0;
  private waiters: (() => void)[] = [];
  readonly directory: string;
  constructor(
    private db: Db,
    root: string,
    private maxVariants = 32,
    private capacity?: Capacity,
  ) {
    this.directory = root + '/cache';
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.lane.then(fn);
    this.lane = next.catch(() => {});
    return next;
  }
  async start({ inventoryOnly = false } = {}): Promise<void> {
    if (!inventoryOnly) {
      if (this.capacity) await this.capacity.ensureDirectory(this.directory);
      else await Deno.mkdir(this.directory, { recursive: true });
    }
    let directoryPresent = true;
    if (this.capacity) {
      try {
        // The inventory uses canonical roots and never follows child links.
        if (!(await Deno.lstat(this.directory)).isDirectory) {
          if (!inventoryOnly) {
            throw new Error('invalid managed cache directory');
          }
          directoryPresent = false;
        } else this.canonicalDirectory = await Deno.realPath(this.directory);
      } catch (error) {
        if (!(inventoryOnly && error instanceof Deno.errors.NotFound)) {
          throw error;
        }
        directoryPresent = false;
      }
    }
    const rows = await listCachedMedia(this.db);
    const known = new Set<string>();
    for (const row of rows) {
      if (!BLOB.test(row.blob)) {
        throw new Error('invalid media cache blob identity');
      }
      if (!directoryPresent) continue;
      try {
        const stat = await Deno.lstat(this.directory + '/' + row.blob);
        if (!stat.isFile || stat.size !== row.size) {
          throw new Deno.errors.NotFound();
        }
        known.add(row.blob);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    // Verify the entire index before making any entry eligible for eviction.
    for (const row of rows) {
      if (known.has(row.blob)) this.register(row);
    }
    if (inventoryOnly) return;
    for (const row of rows) {
      if (!known.has(row.blob)) await deleteCachedMedia(this.db, row.cache_key);
    }
    for await (const entry of Deno.readDir(this.directory)) {
      if (
        (BLOB.test(entry.name) ||
          /^[a-f0-9]{64}-[a-f0-9-]{36}\.part$/.test(entry.name)) &&
        !known.has(entry.name)
      ) {
        const path = this.directory + '/' + entry.name;
        if (this.capacity) await this.capacity.remove(path);
        else await Deno.remove(path);
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
    for (const blob of this.registered.values()) blob.forget();
    this.registered.clear();
  }

  private register(row: CachedMedia): void {
    if (
      !this.capacity || !this.canonicalDirectory ||
      this.registered.has(row.cache_key)
    ) return;
    const blob = {
      get accessedMs() {
        return row.accessed_ms;
      },
      unleased: () =>
        !this.leases.has(row.blob) &&
        !this.pending.has(row.cache_key),
      removed: () => this.registered.delete(row.cache_key),
    };
    const forget = this.capacity.registerCacheBlob(
      this.canonicalDirectory + '/' + row.blob,
      blob,
    );
    this.registered.set(row.cache_key, { row, forget });
  }

  private async find(key: string): Promise<CachedMedia | null> {
    if (this.capacity) return this.registered.get(key)?.row ?? null;
    return await cachedMedia(this.db, key);
  }

  async get(id: CacheIdentity): Promise<CachedMedia | null> {
    return await this.find(await mediaCacheKey(id));
  }
  async fetch(
    id: CacheIdentity,
    maxConcurrent: number,
    producer: (
      output: WritableStream<Uint8Array>,
      signal: AbortSignal,
    ) => Promise<ByteMetadata>,
    signal?: AbortSignal,
    maxBytes?: number,
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
        return await this.fetch(id, maxConcurrent, producer, signal, maxBytes);
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
      maxBytes,
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
    maxBytes?: number,
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
    let space: Reservation | undefined;
    let renamed = false;
    const media = JSON.stringify([id.origin, id.mediaId]);
    let reservation: Set<string> | undefined;
    try {
      const hit = await this.locked(async () => {
        const hit = await this.find(key);
        if (hit || id.scope !== 'thumbnail') return hit;
        const reserved = this.variants.get(media) ?? new Set<string>();
        const variants = this.capacity
          ? [...this.registered.values()].filter(({ row }) =>
            row.scope === 'thumbnail' && row.origin === id.origin &&
            row.media_id === id.mediaId
          ).length
          : await thumbnailVariantCount(this.db, id.origin, id.mediaId);
        if (variants + reserved.size >= this.maxVariants) {
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
      if (this.capacity) {
        if (maxBytes === undefined) {
          throw new Error('media size bound required');
        }
        space = await this.capacity.reserveStaging(part, maxBytes, signal);
        space.track(this.directory + '/' + blob);
      }
      signal.throwIfAborted();
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
          if (maxBytes !== undefined && chunk.length > maxBytes - size) {
            throw new MatrixError(
              413,
              'M_TOO_LARGE',
              'Media exceeds its size limit',
            );
          }
          let offset = 0;
          while (offset < chunk.length) {
            const n = await file!.write(chunk.subarray(offset));
            if (n <= 0) throw new Error('short cache write');
            offset += n;
          }
          size += chunk.length;
        },
      });
      const meta = await (space
        ? withStorageHold(() =>
          producer(output, signal)
        )
        : producer(output, signal));
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
      // Published bytes now belong to the inventory. Do not hold a staging
      // claim while acquiring another claim to commit the cache index row.
      space?.release();
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
        // Pressure eviction unlinks without a transaction so it can free
        // space even when nothing can be written. Replace any stale row.
        if (this.capacity && await cachedMedia(this.db, key)) {
          await deleteCachedMedia(this.db, key);
        }
        await publishCachedMedia(this.db, row);
        this.register(row);
        reservation?.delete(key);
      });
      return row;
    } catch (error) {
      file?.close();
      const path = renamed ? this.directory + '/' + blob : part;
      await (this.capacity ? this.capacity.remove(path) : Deno.remove(path))
        .catch(
          (e) => {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
          },
        );
      throw storageFailure(error);
    } finally {
      space?.release();
      reservation?.delete(key);
      if (this.variants.get(media)?.size === 0) this.variants.delete(media);
      this.active--;
      this.waiters.shift()?.();
    }
  }
  async open(row: CachedMedia): Promise<ReadableStream<Uint8Array>> {
    return await this.locked(async () => {
      const current = this.capacity
        ? this.registered.get(row.cache_key)?.row
        : await cachedMedia(this.db, row.cache_key);
      if (current?.blob !== row.blob) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'Media evicted');
      }
      if (!BLOB.test(row.blob)) {
        throw new Error('invalid media cache blob identity');
      }
      // Mark before the asynchronous open; pressure eviction doesn't take
      // this lane because serving also writes the access timestamp.
      this.leases.set(row.blob, (this.leases.get(row.blob) ?? 0) + 1);
      let file: Deno.FsFile | undefined;
      try {
        file = await Deno.open(this.directory + '/' + row.blob, { read: true });
        const now = Date.now();
        try {
          // The serving lease already protects the file; recency is best
          // effort under pressure and stays current in the live cache index.
          await withStorageHold(() =>
            touchCachedMedia(this.db, row.cache_key, now)
          );
        } catch (error) {
          if (!isStoragePressure(error)) throw error;
        }
        current.accessed_ms = now;
      } catch (error) {
        file?.close();
        this.release(row.blob);
        throw error;
      }
      let closed = false;
      const close = () => {
        if (!closed) {
          closed = true;
          file!.close();
          this.release(row.blob);
        }
      };
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const chunk = new Uint8Array(16384);
            const n = await file!.read(chunk);
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
      !this.capacity && policy.maxbytes <= 0 && !active(policy.remote) &&
      !active(policy.thumbnail)
    ) return;
    await this.locked(async () => {
      const rows = [];
      for (const row of await listCachedMedia(this.db)) {
        const current = this.capacity
          ? this.registered.get(row.cache_key)?.row
          : row;
        if (!current) {
          await deleteCachedMedia(this.db, row.cache_key);
        } else rows.push(current);
      }
      if (this.capacity) {
        // Recency updates can succeed in memory but not on disk. Reorder
        // the managed rows as well as using them for the expiry threshold.
        rows.sort((a, b) =>
          a.accessed_ms - b.accessed_ms ||
          (a.cache_key < b.cache_key ? -1 : a.cache_key > b.cache_key ? 1 : 0)
        );
      }
      let total = rows.reduce((n, r) => n + r.size, 0);
      const scopes = { remote: 0, thumbnail: 0 };
      for (const row of rows) scopes[row.scope] += row.size;
      for (const row of rows) {
        if (this.capacity && !this.registered.has(row.cache_key)) continue;
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
        this.leases.set(row.blob, 1);
        try {
          await deleteCachedMedia(this.db, row.cache_key);
          this.registered.get(row.cache_key)?.forget();
          this.registered.delete(row.cache_key);
          const path = this.directory + '/' + row.blob;
          await (this.capacity ? this.capacity.remove(path) : Deno.remove(path))
            .catch((e) => {
              if (!(e instanceof Deno.errors.NotFound)) throw e;
            });
        } finally {
          this.release(row.blob);
        }
        total -= row.size;
        scopes[row.scope] -= row.size;
      }
    });
  }
}
