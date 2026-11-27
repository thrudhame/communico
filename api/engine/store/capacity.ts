import { lstat, realpath, stat, statfs } from 'node:fs/promises';
import {
  storageHeld,
  storageHold,
  withStorageHold,
} from '#engine/store/holds.ts';
import { type BigIntStats, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, SEPARATOR } from '@std/path';
import { databaseFiles } from '#engine/store/layout.ts';
import { abortable } from '#engine/net/abort.ts';
import {
  type Allocation,
  CapacityLedger,
  contains,
} from './capacity-ledger.ts';
import {
  StorageBusyError,
  storageFailure,
  StoragePressureError,
} from './pressure.ts';

type Space = {
  device: string | number;
  totalBytes: number;
  freeBytes: number;
  freeInodes: number | null;
  blockSize: number;
};

export type CapacityProbe = (path: string) => Space | Promise<Space>;
type QuotaProbe = (path: string) => Promise<boolean>;

type Claim = {
  device: string;
  bytes: number;
  inodes: number;
  paths: Set<string>;
};
type NativeFrame = { offset: number; length: number };
type Footprint = {
  bytes: number;
  inodes: number;
  metadataBlocks: number;
  files?: readonly number[];
  frames?: readonly NativeFrame[];
  undo?: boolean;
  native?: boolean;
};
type CacheBlob = {
  accessedMs: number;
  unleased(): boolean;
  removed(): void;
};
type RegisteredBlob = CacheBlob & { inode: bigint; device: string };
type Reclaimable = {
  path: string;
  inode: bigint;
  device: string;
  physicalDevice: string;
  bytes: number;
  blob: RegisteredBlob;
};
export type Reservation = {
  track(...paths: string[]): void;
  release(): void;
};
export type NativeReservation = Reservation & {
  blockSize: number;
  bytes: number;
  undoBytes: number;
  creates: number;
  scratchRoot?: string;
};

async function physicalSpace(path: string, device: string): Promise<Space> {
  const fs = await statfs(path, { bigint: true });
  return {
    device,
    totalBytes: Number(fs.blocks * fs.bsize),
    freeBytes: Number(fs.bavail * fs.bsize),
    freeInodes: fs.files === 0n ? null : Number(fs.ffree),
    blockSize: Number(fs.bsize),
  };
}

type FilesystemCapacity = {
  device: string;
  totalBytes: number;
  freeBytes: number;
  freeInodes: number | null;
  budgetBytes: number | null;
  usedBytes: number;
  reservedBytes: number;
  protectedBytes: number;
  reclaimableBytes: number;
  quotaBackstop: boolean;
  filesystemFull: boolean;
  checkpoint: {
    active: boolean;
    overshootBytes: number;
    peakOvershootBytes: number;
    retainedWalBytes: number;
  };
};

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The facade's capacity inventory is keyed by filesystem, not by root. */
export class Capacity {
  private lane: Promise<unknown> = Promise.resolve();
  private readonly fifo = new Set<() => void>();
  private readonly releaseWaiters = new Set<() => void>();
  private readonly claims = new Set<Claim>();
  private readonly claimsByDevice = new Map<string, Claim>();
  private reserved = 0;
  private ledger = new CapacityLedger();
  private readonly locations = new Map<
    string,
    Awaited<ReturnType<typeof ancestor>>
  >();
  private rootPaths: readonly string[] = [];
  private initialized?: Promise<void>;
  private scanning?: Promise<Awaited<ReturnType<Capacity['inventory']>>>;
  private changes?: Set<string>;
  private settlementFailure?: { cause: unknown };
  private readonly cache = new Map<string, RegisteredBlob>();
  private released = Promise.withResolvers<void>();
  private checkpointActive?: {
    device?: string;
    peakOvershootBytes: number;
    paths: string[];
  };
  private readonly checkpointPeaks = new Map<string, number>();
  private readonly checkpointFailures = new Map<string, string>();
  private scratchRoot?: string;
  private scratchObservedPeakBytes = 0;

  constructor(
    private readonly roots: readonly string[],
    private readonly budget?: number | null,
    private readonly probe?: CapacityProbe,
  ) {}

  initialize(): Promise<void> {
    return this.initialized ??= (async () => {
      const roots = await Promise.all(this.roots.map(ancestor));
      this.rootPaths = roots.map((at) => at.target);
      for (const root of roots) this.locations.set(root.target, root);
      this.ledger = (await this.inventory()).ledger;
    })();
  }

  accountedBytes(): number {
    return this.ledger.total;
  }

  private managed(path: string): boolean {
    return this.rootPaths.some((root) => contains(root, path));
  }

  private path(path: string): string {
    path = resolve(path);
    for (let i = 0; i < this.roots.length; i++) {
      const root = resolve(this.roots[i]);
      if (contains(root, path)) {
        return resolve(this.rootPaths[i], relative(root, path));
      }
    }
    return path;
  }

  /** Settle the bounded set of files/parents the operation could mutate.
   * Settlement is synchronous so another grant sees either the reservation
   * or the allocated bytes, never a gap between the two. */
  refresh(...paths: string[]): void {
    this.refreshPaths(new Set(paths));
  }

  private refreshPaths(paths: Iterable<string>): void {
    for (const input of paths) {
      const path = this.path(input);
      if (!this.managed(path)) continue;
      this.changes?.add(path);
      try {
        const entry = lstatSync(path, { bigint: true });
        const location = this.ledger.location(dirname(path));
        const physicalDevice = String(entry.dev);
        const existing = this.ledger.paths.get(path);
        const device = existing?.physicalDevice === physicalDevice
          ? existing.device
          : location?.allocation.physicalDevice === physicalDevice
          ? location.allocation.device
          : String(physicalDevice);
        this.ledger.set(path, allocation(entry, device));
      } catch (error) {
        if (missing(error)) this.ledger.set(path);
        else this.settlementFailure = { cause: error };
      }
    }
  }

  async remove(path: string, options?: Deno.RemoveOptions): Promise<void> {
    await this.initialize();
    path = this.path(path);
    const affected = options?.recursive
      ? [...this.ledger.paths.keys()].filter((key) => contains(path, key))
      : [path];
    affected.push(dirname(path));
    try {
      await Deno.remove(path, options);
    } finally {
      this.refreshPaths(affected);
    }
  }

  /** Account for an owned rename without reading its descendants again. */
  moved(source: string, destination: string): void {
    source = this.path(source);
    destination = this.path(destination);
    const entries = this.ledger.paths.get(source)?.directory
      ? [...this.ledger.paths].filter(([key]) => contains(source, key))
      : [...this.ledger.paths].filter(([key]) => key === source);
    for (const [key] of entries) {
      const to = resolve(destination, relative(source, key));
      this.changes?.add(key);
      this.changes?.add(to);
      if (this.managed(to)) this.ledger.move(key, to);
      else this.ledger.set(key);
    }
    this.refresh(source, destination, dirname(source), dirname(destination));
  }

  private async reconcile() {
    await this.initialize();
    return await (this.scanning ??= (async () => {
      // Neither this walk nor a paused observer holds the admission lane.
      // Grants register mutation paths at admission and again at settlement;
      // retain those entries from the live ledger rather than installing a
      // stale scan (or charging a partly written file as well as its grant).
      const changed = this.changes = new Set<string>();
      for (const claim of this.claims) {
        for (const path of claim.paths) changed.add(path);
      }
      for (const path of this.checkpointActive?.paths ?? []) changed.add(path);
      const priorFailure = this.settlementFailure;
      try {
        const fresh = await this.inventory();
        for (const path of changed) {
          fresh.ledger.set(path, this.ledger.paths.get(path));
        }
        this.ledger = fresh.ledger;
        const reclaimable = new Map<string, number>();
        for (const entry of this.reclaimable()) {
          reclaimable.set(
            entry.device,
            (reclaimable.get(entry.device) ?? 0) + entry.bytes,
          );
        }
        for (const disk of fresh.filesystems) {
          disk.usedBytes = this.ledger.used(disk.device) +
            fresh.scratch.used(disk.device);
          disk.reclaimableBytes = reclaimable.get(disk.device) ?? 0;
          disk.protectedBytes = disk.usedBytes - disk.reclaimableBytes;
          disk.reservedBytes = this.claimsByDevice.get(disk.device)?.bytes ?? 0;
        }
        if (this.settlementFailure === priorFailure) {
          this.settlementFailure = undefined;
        }
        return fresh;
      } finally {
        this.changes = undefined;
        this.scanning = undefined;
      }
    })());
  }

  private notifyRelease(): void {
    this.released.resolve();
    this.released = Promise.withResolvers<void>();
    for (const wake of this.releaseWaiters) wake();
    this.releaseWaiters.clear();
  }

  private async waitForRelease(released: Promise<void>, signal?: AbortSignal) {
    if (!signal) return await released;
    signal.throwIfAborted();
    if (released !== this.released.promise) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    this.releaseWaiters.add(resolve);
    try {
      await abortable(signal, () => promise);
    } finally {
      this.releaseWaiters.delete(resolve);
    }
  }

  setScratchRoot(path: string): void {
    this.scratchRoot = path;
    if (this.rootPaths.length === 0) return;
    // Routing can follow initial inventory (directory creation needs the
    // owner). Discard any previously observed transient allocations once.
    const root = this.path(path);
    for (const known of this.ledger.paths.keys()) {
      if (known !== root && contains(root, known)) {
        this.changes?.add(known);
        this.ledger.set(known);
      }
    }
  }

  get nativeScratchRoot(): string | undefined {
    return this.scratchRoot;
  }

  /** The cache owner registers committed, replaceable blobs, never staging. */
  registerCacheBlob(path: string, blob: CacheBlob): () => void {
    const file = lstatSync(path, { bigint: true });
    const registered = Object.assign(blob, {
      inode: file.ino,
      device: String(file.dev),
    });
    this.cache.set(path, registered);
    return () => {
      if (this.cache.get(path) === registered) this.cache.delete(path);
    };
  }

  private oldest(blobs: Reclaimable[]): Reclaimable[] {
    return blobs.sort((a, b) =>
      a.blob.accessedMs - b.blob.accessedMs ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    );
  }

  private reclaimable(): Reclaimable[] {
    return this.oldest([...this.cache].flatMap(([path, blob]) => {
      const entry = this.ledger.paths.get(path);
      return entry && entry.inode === blob.inode &&
          entry.physicalDevice === blob.device && entry.links === 1n &&
          !entry.directory && !entry.symlink && blob.unleased()
        ? [{
          path,
          blob,
          inode: entry.inode,
          device: entry.device,
          physicalDevice: blob.device,
          bytes: entry.bytes,
        }]
        : [];
    }));
  }

  private evict(entry: Reclaimable): boolean {
    // No await between checking the serving lease/identity and unlinking.
    // This path cannot take the cache lane or write its DB: the reservation
    // may itself be for a cache index transaction, with the disk full.
    const { path, blob } = entry;
    if (this.cache.get(path) !== blob || !blob.unleased()) return false;
    try {
      const file = lstatSync(path, { bigint: true });
      if (
        !file.isFile() || file.nlink !== 1n || file.ino !== entry.inode ||
        String(file.dev) !== entry.physicalDevice
      ) return false;
      Deno.removeSync(path);
    } catch (error) {
      if (
        missing(error) || error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.PermissionDenied ||
        (error instanceof Error && 'code' in error && error.code === 'EROFS') ||
        storageFailure(error) instanceof StoragePressureError
      ) return false;
      throw storageFailure(error);
    }
    this.cache.delete(path);
    this.refresh(path, dirname(path));
    blob.removed();
    return true;
  }

  // Sample scratch at checkpoints and status reads, never on the SQL hot path.
  observeScratch(): Promise<number> | undefined {
    if (this.scratchRoot === undefined) return;
    return this.measureScratch(this.scratchRoot).then((bytes) => {
      this.scratchObservedPeakBytes = Math.max(
        this.scratchObservedPeakBytes,
        bytes,
      );
      return bytes;
    });
  }

  private async measureScratch(root: string): Promise<number> {
    const seen = new Set<string>();
    const visit = async (path: string): Promise<number> => {
      let bytes = 0;
      try {
        const entry = await lstat(path, { bigint: true });
        const identity = `${entry.dev}:${entry.ino}`;
        if (seen.has(identity)) return 0;
        seen.add(identity);
        // The permanent scratch directory belongs to ordinary inventory;
        // report only its temporary contents in the scratch counter.
        if (path !== root) bytes = Number(entry.blocks * 512n);
        if (entry.isDirectory()) {
          for await (const child of Deno.readDir(path)) {
            bytes += await visit(join(path, child.name));
          }
        }
      } catch (error) {
        if (!missing(error) && !(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
      return bytes;
    };
    return await visit(root);
  }

  private async space(
    at: Awaited<ReturnType<typeof ancestor>>,
  ): Promise<Space> {
    return await (this.probe?.(at.target) ?? physicalSpace(at.path, at.device));
  }

  /** Claim the entire footprint, including metadata blocks, before writing. */
  reserve(
    path: string,
    footprint: { bytes: number; inodes: number; metadataBlocks: number },
  ): Promise<Reservation> {
    return this.claim(path, footprint);
  }

  /** The estimate determines this attempt's ceiling, not a transaction limit. */
  reserveNative(
    path: string,
    creates: number,
    bytes: number | readonly NativeFrame[],
    undo = true,
  ): Promise<NativeReservation> {
    return this.claim(path, nativeFootprint(creates, bytes, undo));
  }

  /** A live transaction may try once, but may only queue after rollback. */
  tryReserveNative(
    path: string,
    creates: number,
    bytes: number,
  ): Promise<NativeReservation> {
    return this.tryClaim(
      path,
      nativeFootprint(creates, bytes, true),
      false,
      storageHold(),
    );
  }

  private async claim(
    path: string,
    footprint: Footprint,
    publication = false,
    signal?: AbortSignal,
  ): Promise<NativeReservation> {
    const guarded = storageHeld();
    const hold = storageHold();
    const attempt = () =>
      this.tryClaim(path, footprint, publication, hold, signal);
    let release: Promise<void>;
    try {
      return await attempt();
    } catch (error) {
      signal?.throwIfAborted();
      if (guarded || !(error instanceof StorageBusyError)) throw error;
      release = error.released;
    }
    // Only requests that actually encountered pressure enter the FIFO. A
    // request that fits can proceed even if another device or a larger request
    // is waiting for room. Retry only after the blocking capacity changes.
    const ready = Promise.withResolvers<void>();
    this.fifo.add(ready.resolve);
    if (this.fifo.size === 1) ready.resolve();
    try {
      await abortable(signal, () => ready.promise);
      for (;;) {
        await this.waitForRelease(release, signal);
        try {
          return await attempt();
        } catch (error) {
          if (!(error instanceof StorageBusyError)) throw error;
          release = error.released;
        }
      }
    } finally {
      const head = this.fifo.values().next().value === ready.resolve;
      this.fifo.delete(ready.resolve);
      if (head) this.fifo.values().next().value?.();
    }
  }

  private tryClaim(
    path: string,
    footprint: Footprint,
    publication: boolean,
    hold: () => () => void,
    signal?: AbortSignal,
  ): Promise<NativeReservation> {
    const result = this.lane.then(async () => {
      signal?.throwIfAborted();
      await this.initialize();
      if (this.settlementFailure) {
        throw new StoragePressureError(this.settlementFailure.cause);
      }
      const busy = () => new StorageBusyError(this.released.promise);
      if (this.checkpointActive) throw busy();
      if (
        [
          footprint.bytes,
          footprint.inodes,
          footprint.metadataBlocks,
          ...(footprint.files ?? []),
          ...(footprint.frames ?? []).flatMap((
            { offset, length },
          ) => [offset, length]),
        ]
          .some((n) => !Number.isSafeInteger(n) || n < 0)
      ) {
        throw new RangeError('invalid storage footprint');
      }
      path = this.path(path);
      const managed = this.managed(path);
      if (!publication && !managed) {
        throw new Error('reservation outside capacity roots');
      }
      const at = this.ledger.location(path);
      const root = this.rootPaths.find((root) => contains(root, path));
      const location = at
        ? { path: at.path, device: at.allocation.device }
        : (root && this.locations.get(root)) || await ancestor(path);
      const sample = async () => {
        const epoch = this.released;
        const result = await (this.probe?.(path) ??
          physicalSpace(location.path, location.device));
        signal?.throwIfAborted();
        if (this.checkpointActive) throw busy();
        if (this.settlementFailure) {
          throw new StoragePressureError(this.settlementFailure.cause);
        }
        return { space: result, epoch };
      };
      const explicit = typeof this.budget === 'number';
      // Releases may change both free space and unsettled claims during a
      // probe. Compare its epoch in the same turn that decides admission.
      let observed = await sample();
      while (observed.epoch !== this.released) observed = await sample();
      signal?.throwIfAborted();
      let { space } = observed;
      const { blockSize } = space;
      const device = String(space.device);
      const metadata = footprint.metadataBlocks * blockSize;
      const work = [footprint.bytes, ...(footprint.files ?? [])].reduce(
        (sum, size) => sum + Math.ceil(size / blockSize) * blockSize,
        0,
      ) + (footprint.frames ?? []).reduce(
        (sum, { offset, length }) =>
          sum +
          Math.ceil((offset % blockSize + length) / blockSize) * blockSize,
        0,
      );
      const undoBytes = footprint.undo ? work : 0;
      const data = work + undoBytes;
      const needs = data + metadata;
      const budgetRemaining = () => {
        const used = explicit
          ? this.accountedBytes()
          : this.ledger.used(device);
        const budget = this.budget === null
          ? Infinity
          : this.budget ?? Math.floor(space.totalBytes * 0.99);
        return budget - used;
      };
      let budgetLeft = budgetRemaining();
      let inodesLeft = space.freeInodes ?? Infinity;
      let inodes = footprint.inodes - inodesLeft;
      let physical = needs - space.freeBytes;
      let software = needs - budgetLeft;
      if (this.checkpointActive) throw busy();
      let local = this.claimsByDevice.get(device);
      if (physical > 0 || software > 0 || inodes > 0) {
        const eligible = this.reclaimable();
        const here = eligible.filter((entry) => entry.device === device);
        const blocks = (entries: Reclaimable[]) =>
          entries.reduce((sum, entry) => sum + entry.bytes, 0);
        // An impossible request must not empty the cache as a side effect.
        const reclaimBytes = blocks(here);
        if (
          physical > reclaimBytes + (local?.bytes ?? 0) ||
          inodes > here.length + (local?.inodes ?? 0) ||
          software > blocks(explicit ? eligible : here)
        ) {
          throw new StoragePressureError();
        }
        if (physical > reclaimBytes || inodes > here.length) throw busy();
        for (const entry of eligible) {
          if (
            !((entry.device === device && (physical > 0 || inodes > 0)) ||
              ((explicit || entry.device === device) && software > 0))
          ) continue;
          if (!this.evict(entry)) continue;
          if (entry.device === device) {
            physical -= entry.bytes;
            inodes--;
          }
          if (explicit || entry.device === device) software -= entry.bytes;
          if (physical <= 0 && software <= 0 && inodes <= 0) break;
        }
        observed = await sample();
        while (observed.epoch !== this.released) observed = await sample();
        signal?.throwIfAborted();
        space = observed.space;
        local = this.claimsByDevice.get(device);
        budgetLeft = budgetRemaining();
        inodesLeft = space.freeInodes ?? Infinity;
        if (this.checkpointActive) throw busy();
        if (
          needs > Math.min(space.freeBytes, budgetLeft) ||
          footprint.inodes > inodesLeft
        ) {
          if (
            needs <=
              Math.min(space.freeBytes + (local?.bytes ?? 0), budgetLeft) &&
            footprint.inodes <= inodesLeft + (local?.inodes ?? 0)
          ) throw busy();
          throw new StoragePressureError();
        }
      }
      const available = Math.min(
        space.freeBytes - (local?.bytes ?? 0),
        budgetLeft - (explicit ? this.reserved : local?.bytes ?? 0),
      );
      if (
        this.checkpointActive || needs > available ||
        footprint.inodes > inodesLeft - (local?.inodes ?? 0)
      ) throw busy();
      const paths = new Set([path, dirname(path)]);
      if (footprint.native) {
        paths.add(path + '-log');
        paths.add(path + '-wal');
      }
      const claim: Claim = {
        device,
        bytes: needs,
        inodes: footprint.inodes,
        paths,
      };
      const unhold = hold();
      this.claims.add(claim);
      this.reserved += needs;
      const totals = this.claimsByDevice.get(device) ??
        { device, bytes: 0, inodes: 0, paths: new Set<string>() };
      totals.bytes += needs;
      totals.inodes += footprint.inodes;
      this.claimsByDevice.set(device, totals);
      const track = (...inputs: string[]) => {
        for (const input of inputs) {
          const key = this.path(input);
          paths.add(key);
          paths.add(dirname(key));
          this.changes?.add(key);
          this.changes?.add(dirname(key));
        }
      };
      for (const key of paths) this.changes?.add(key);
      return {
        track,
        release: () => {
          if (this.claims.delete(claim)) {
            try {
              this.refreshPaths(paths);
            } finally {
              this.reserved -= needs;
              totals.bytes -= needs;
              totals.inodes -= footprint.inodes;
              if (!totals.bytes && !totals.inodes) {
                this.claimsByDevice.delete(device);
              }
              unhold();
              this.notifyRelease();
            }
          }
        },
        blockSize,
        bytes: data,
        undoBytes,
        creates: footprint.inodes,
        scratchRoot: this.scratchRoot,
      };
    });
    this.lane = result.catch(() => {});
    return result;
  }

  // Only publication can target an operator-managed location. Its temporary
  // duplicate still competes with every other grant until publish or cleanup.
  reservePublication(
    path: string,
    inodes: number,
    files: readonly number[],
  ): Promise<Reservation> {
    return this.claim(path, {
      bytes: 0,
      inodes,
      metadataBlocks: 8 + inodes * 5,
      files,
    }, true);
  }

  reserveStaging(
    path: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<Reservation> {
    // One private inode; leave room for both directory entries (create and
    // publication rename) and their directory index updates.
    return this.claim(
      path,
      {
        bytes: maxBytes,
        inodes: 1,
        metadataBlocks: 8,
      },
      false,
      signal,
    );
  }

  async withMetadata<T>(
    path: string,
    inodes: number,
    write: (lease: Reservation) => Promise<T>,
  ): Promise<T> {
    // Reserve the inode and worst-case directory entry/index updates. Rename
    // also needs destination metadata even when it moves no file payload.
    const lease = await this.reserve(path, {
      bytes: 0,
      inodes,
      metadataBlocks: 8,
    });
    try {
      return await withStorageHold(() => write(lease));
    } catch (error) {
      throw storageFailure(error);
    } finally {
      lease.release();
    }
  }

  async ensureDirectory(path: string, mode?: number): Promise<void> {
    const target = resolve(path);
    const at = await ancestor(target);
    if (at.original === target) return;
    const parts = relative(at.original, target).split(SEPARATOR);
    // Claim all missing components before recursive mkdir can create any.
    const lease = await this.reserve(target, {
      bytes: 0,
      inodes: parts.length,
      metadataBlocks: parts.length * 5,
    });
    for (let path = target; path !== at.original; path = dirname(path)) {
      lease.track(path);
    }
    try {
      await Deno.mkdir(target, { recursive: true, mode });
    } catch (error) {
      throw storageFailure(error);
    } finally {
      lease.release();
    }
  }

  /** Native work discovers its footprint only as it writes. Reclaim only
   * after rollback and release of its reservation, never inside Turso IO. */
  reclaimAfterFull(path: string): Promise<boolean> {
    const result = this.lane.then(async () => {
      await this.initialize();
      if (this.checkpointActive || this.cache.size === 0) return false;
      const device = this.ledger.location(this.path(path))?.allocation.device;
      return this.reclaimable().some((entry) =>
        (entry.device === device || typeof this.budget === 'number') &&
        this.evict(entry)
      );
    });
    this.lane = result.catch(() => {});
    return result;
  }

  /** Never wait here: the file gate already has ordinary transactions paused. */
  async tryCheckpoint(path: string): Promise<
    {
      observe(peakBytes: number): void;
      finish(outcome?: 'full' | 'completed'): void;
    } | undefined
  > {
    // Never wait for a claim while its writer may be waiting on this file gate.
    if (this.checkpointActive || this.claims.size !== 0) return;
    const files = databaseFiles(dirname(path));
    const paths = [files.database, files.log, files.wal, dirname(path)].map((
      file,
    ) => this.path(file));
    const active: NonNullable<Capacity['checkpointActive']> = {
      peakOvershootBytes: 0,
      paths,
    };
    this.checkpointActive = active;
    for (const file of paths) this.changes?.add(file);
    try {
      const space = await this.space(await ancestor(path));
      const device = active.device = String(space.device);
      if (
        this.checkpointFailures.has(files.wal) &&
        this.reclaimable().some((entry) =>
          entry.device === device && this.evict(entry)
        )
      ) this.notifyRelease();
      const budget = this.budget === null
        ? Infinity
        : this.budget ?? Math.floor(space.totalBytes * 0.99);
      const dbBytes = await allocated(files.database) +
        await allocated(files.log) + await allocated(files.wal);
      const used = typeof this.budget === 'number'
        ? this.ledger.total
        : this.ledger.used(device);
      return {
        observe: (peak) => {
          active.peakOvershootBytes = Math.max(
            active.peakOvershootBytes,
            used - dbBytes + peak - budget,
          );
        },
        finish: (outcome) => {
          if (outcome === 'full') {
            this.checkpointFailures.set(files.wal, device);
          }
          if (outcome === 'completed') {
            this.checkpointFailures.delete(files.wal);
          }
          try {
            this.refreshPaths(paths);
            this.checkpointPeaks.set(device, active.peakOvershootBytes);
          } finally {
            this.checkpointActive = undefined;
            this.notifyRelease();
            void this.reconcile().catch(() => {});
          }
        },
      };
    } catch (error) {
      this.checkpointActive = undefined;
      this.notifyRelease();
      throw error;
    }
  }

  private async inventory(quotaPaths?: Map<FilesystemCapacity, string>) {
    const ledger = new CapacityLedger();
    const scratch = new CapacityLedger();
    const scratchRoot = this.scratchRoot && this.path(this.scratchRoot);
    const filesystems = new Map<string, FilesystemCapacity>();
    const seen = new Set<string>();
    const filesystem = (space: Space, path: string) => {
      const device = String(space.device);
      const known = filesystems.get(device);
      if (known) return known;
      const disk: FilesystemCapacity = {
        device,
        totalBytes: space.totalBytes,
        freeBytes: space.freeBytes,
        freeInodes: space.freeInodes,
        budgetBytes: this.budget === null
          ? null
          : this.budget ?? Math.floor(space.totalBytes * 0.99),
        usedBytes: 0,
        reservedBytes: 0,
        protectedBytes: 0,
        reclaimableBytes: 0,
        quotaBackstop: false,
        filesystemFull: space.freeBytes === 0 || space.freeInodes === 0,
        checkpoint: {
          active: this.checkpointActive?.device === device,
          overshootBytes: 0,
          peakOvershootBytes: this.checkpointActive?.device === device
            ? this.checkpointActive.peakOvershootBytes
            : this.checkpointPeaks.get(device) ?? 0,
          retainedWalBytes: 0,
        },
      };
      filesystems.set(device, disk);
      quotaPaths?.set(disk, path);
      return disk;
    };
    const visit = async (
      path: string,
      parent: FilesystemCapacity,
      parentDevice: string,
      volatile = false,
    ) => {
      try {
        const entry = await lstat(path, { bigint: true });
        const device = String(entry.dev);
        const identity = `${device}:${entry.ino}`;
        // Never follow entries that link out of a managed root. The inode's
        // allocation belongs to the parent even when its target is elsewhere.
        const disk = entry.isSymbolicLink() || device === parentDevice
          ? parent
          : filesystem(
            await this.space({ path, device, original: path, target: path }),
            path,
          );
        (volatile ? scratch : ledger).set(path, allocation(entry, disk.device));
        if (seen.has(identity)) return;
        seen.add(identity);
        if (entry.isDirectory()) {
          for await (const child of Deno.readDir(path)) {
            await visit(
              join(path, child.name),
              disk,
              device,
              volatile || path === scratchRoot,
            );
          }
        }
      } catch (error) {
        if (!missing(error) && !(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    };
    for (const root of this.roots) {
      const at = await ancestor(root);
      const disk = filesystem(await this.space(at), at.path);
      // A missing root may allocate on its ancestor's filesystem, but does
      // not include the ancestor's existing data in the facade inventory.
      if (at.original === resolve(root)) await visit(at.path, disk, at.device);
    }
    for (const [wal, device] of this.checkpointFailures) {
      const disk = filesystems.get(device);
      if (!disk) continue;
      disk.filesystemFull = true;
      // Already counted once in protectedBytes by the ordinary inventory.
      disk.checkpoint.retainedWalBytes += await allocated(wal);
    }
    const disks = [...filesystems.values()];
    for (const disk of disks) {
      if (!disk.checkpoint.active) continue;
      const used = typeof this.budget === 'number'
        ? ledger.total + scratch.total
        : ledger.used(disk.device) + scratch.used(disk.device);
      const overshoot = Math.max(0, used - (disk.budgetBytes ?? Infinity));
      disk.checkpoint.overshootBytes = overshoot;
      disk.checkpoint.peakOvershootBytes = Math.max(
        disk.checkpoint.peakOvershootBytes,
        overshoot,
      );
    }
    return { filesystems: disks, scratch, ledger };
  }

  async status(probeQuota?: QuotaProbe) {
    const { filesystems, scratch } = await this.reconcile();
    if (probeQuota) {
      await Promise.all(filesystems.map(async (disk) => {
        const path = [...this.ledger.paths].find(([, entry]) =>
          entry.device === disk.device
        )?.[0] ?? this.rootPaths[0];
        disk.quotaBackstop = await probeQuota(path);
      }));
    }
    const currentBytes = scratch.total;
    this.scratchObservedPeakBytes = Math.max(
      this.scratchObservedPeakBytes,
      currentBytes,
    );
    return {
      filesystems,
      scratch: {
        currentBytes,
        observedPeakBytes: this.scratchObservedPeakBytes,
      },
    };
  }
}

function allocation(entry: BigIntStats, device: string): Allocation {
  return {
    device,
    physicalDevice: String(entry.dev),
    inode: entry.ino,
    bytes: Number(entry.blocks * 512n),
    links: entry.nlink,
    directory: entry.isDirectory(),
    symlink: entry.isSymbolicLink(),
  };
}

function nativeFootprint(
  creates: number,
  bytes: number | readonly NativeFrame[],
  undo: boolean,
): Footprint {
  return {
    bytes: typeof bytes === 'number' ? bytes : 0,
    frames: typeof bytes === 'number' ? undefined : bytes,
    inodes: creates,
    metadataBlocks: creates * 5,
    undo,
    native: true,
  };
}

async function ancestor(target: string) {
  target = resolve(target);
  for (let original = target;;) {
    try {
      const path = await realpath(original);
      return {
        original,
        path,
        target: resolve(path, relative(original, target)),
        device: String((await stat(path, { bigint: true })).dev),
      };
    } catch (error) {
      const parent = dirname(original);
      if (!missing(error) || original === parent) throw error;
      original = parent;
    }
  }
}

async function allocated(path: string): Promise<number> {
  try {
    return Number((await lstat(path, { bigint: true })).blocks * 512n);
  } catch (error) {
    if (missing(error)) return 0;
    throw error;
  }
}
