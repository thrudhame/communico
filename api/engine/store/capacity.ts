import { lstat, realpath, stat, statfs } from 'node:fs/promises';
import {
  storageHeld,
  storageHold,
  withStorageHold,
} from '#engine/store/holds.ts';
import { lstatSync } from 'node:fs';
import { dirname, join, relative, resolve, SEPARATOR } from '@std/path';
import { databaseFiles } from '#engine/store/layout.ts';
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

type Claim = { device: string; bytes: number; inodes: number };
type NativeFrame = { offset: number; length: number };
type Footprint = {
  bytes: number;
  inodes: number;
  metadataBlocks: number;
  files?: readonly number[];
  frames?: readonly NativeFrame[];
  undo?: boolean;
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
export type Reservation = { release(): void };
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
  private fifo: Promise<unknown> = Promise.resolve();
  private readonly claims = new Set<Claim>();
  private readonly cache = new Map<string, RegisteredBlob>();
  private released = Promise.withResolvers<void>();
  private checkpointActive?: { device?: string; peakOvershootBytes: number };
  private readonly checkpointPeaks = new Map<string, number>();
  private readonly checkpointFailures = new Map<string, string>();
  private scratchRoot?: string;
  private scratchObservedPeakBytes = 0;

  constructor(
    private readonly roots: readonly string[],
    private readonly budget?: number | null,
    private readonly probe?: CapacityProbe,
  ) {}

  private notifyRelease(): void {
    this.released.resolve();
    this.released = Promise.withResolvers<void>();
  }

  setScratchRoot(path: string): void {
    this.scratchRoot = path;
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
    blob.removed();
    return true;
  }

  // At statement/checkpoint boundaries, sample just scratch rather than
  // the whole store. Telemetry must not change the outcome of native work.
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
  ): Promise<NativeReservation> {
    const guarded = storageHeld();
    const hold = storageHold();
    const attempt = () => this.tryClaim(path, footprint, publication, hold);
    let release: Promise<void>;
    try {
      return await attempt();
    } catch (error) {
      if (guarded || !(error instanceof StorageBusyError)) throw error;
      release = error.released;
    }
    // Only requests that actually encountered pressure enter the FIFO. A
    // request that fits can proceed even if another device or a larger request
    // is waiting for room. Retry only after the blocking capacity changes.
    const result = this.fifo.then(async () => {
      for (;;) {
        await release;
        try {
          return await attempt();
        } catch (error) {
          if (!(error instanceof StorageBusyError)) throw error;
          release = error.released;
        }
      }
    });
    this.fifo = result.catch(() => {});
    return result;
  }

  private tryClaim(
    path: string,
    footprint: Footprint,
    publication: boolean,
    hold: () => () => void,
  ): Promise<NativeReservation> {
    const result = this.lane.then(async () => {
      const { promise: released } = this.released;
      if (this.checkpointActive) throw new StorageBusyError(released);
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
      // Releases can race the inventory scan. Include every claim that was
      // alive before scanning, even if its new blocks aren't visible yet.
      const outstanding = [...this.claims];
      const at = await ancestor(path);
      const roots = await Promise.all(this.roots.map(ancestor));
      if (
        !publication && !roots.some((root) => contains(root.target, at.target))
      ) {
        throw new Error('reservation outside capacity roots');
      }
      const explicit = typeof this.budget === 'number';
      let space = await this.space(at);
      const { blockSize } = space;
      const device = String(space.device);
      const metadata = footprint.metadataBlocks * blockSize;
      const local = outstanding.filter((claim) => claim.device === device);
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
      let snap = await this.inventory();
      const budgetRemaining = () => {
        const disk = snap.filesystems.find((disk) => disk.device === device);
        if (!disk && !publication) {
          throw new Error('reservation device outside capacity roots');
        }
        const used = explicit
          ? snap.filesystems.reduce((sum, disk) => sum + disk.usedBytes, 0)
          : disk?.usedBytes ?? 0;
        const budget = this.budget === null
          ? Infinity
          : disk?.budgetBytes ?? this.budget ??
            Math.floor(space.totalBytes * 0.99);
        return budget - used;
      };
      let budgetLeft = budgetRemaining();
      let inodesLeft = space.freeInodes ?? Infinity;
      let inodes = footprint.inodes - inodesLeft;
      let physical = needs - space.freeBytes;
      let software = needs - budgetLeft;
      if (this.checkpointActive) throw new StorageBusyError(released);
      if (physical > 0 || software > 0 || inodes > 0) {
        const eligible = this.oldest(snap.reclaimable);
        const here = eligible.filter((entry) => entry.device === device);
        const blocks = (entries: Reclaimable[]) =>
          entries.reduce((sum, entry) => sum + entry.bytes, 0);
        // An impossible request must not empty the cache as a side effect.
        if (
          physical > blocks(here) || inodes > here.length ||
          software > blocks(explicit ? eligible : here)
        ) throw new StoragePressureError();
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
        space = await this.space(at);
        snap = await this.inventory();
        budgetLeft = budgetRemaining();
        inodesLeft = space.freeInodes ?? Infinity;
        if (this.checkpointActive) throw new StorageBusyError(released);
        if (
          needs > Math.min(space.freeBytes, budgetLeft) ||
          footprint.inodes > inodesLeft
        ) throw new StoragePressureError();
      }
      const available = Math.min(
        space.freeBytes - claimedBytes(local),
        budgetLeft - claimedBytes(explicit ? outstanding : local),
      );
      if (
        this.checkpointActive || needs > available ||
        footprint.inodes > inodesLeft -
            local.reduce((sum, claim) => sum + claim.inodes, 0)
      ) throw new StorageBusyError(released);
      const claim = {
        device,
        bytes: needs,
        inodes: footprint.inodes,
      };
      const unhold = hold();
      this.claims.add(claim);
      return {
        release: () => {
          if (this.claims.delete(claim)) {
            unhold();
            this.notifyRelease();
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

  reserveStaging(path: string, maxBytes: number): Promise<Reservation> {
    // One private inode; leave room for both directory entries (create and
    // publication rename) and their directory index updates.
    return this.reserve(path, {
      bytes: maxBytes,
      inodes: 1,
      metadataBlocks: 8,
    });
  }

  async withMetadata<T>(
    path: string,
    inodes: number,
    write: () => Promise<T>,
  ): Promise<T> {
    // Reserve the inode and worst-case directory entry/index updates. Rename
    // also needs destination metadata even when it moves no file payload.
    const lease = await this.reserve(path, {
      bytes: 0,
      inodes,
      metadataBlocks: 8,
    });
    try {
      return await withStorageHold(write);
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
      if (this.checkpointActive || this.cache.size === 0) return false;
      const device = String((await this.space(await ancestor(path))).device);
      const { reclaimable } = await this.inventory();
      if (this.checkpointActive) return false;
      return this.oldest(reclaimable).some((entry) =>
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
    const active: NonNullable<Capacity['checkpointActive']> = {
      peakOvershootBytes: 0,
    };
    this.checkpointActive = active;
    try {
      const files = databaseFiles(dirname(path));
      const device = active.device = String(
        (await this.space(await ancestor(path))).device,
      );
      let { filesystems, reclaimable } = await this.inventory();
      if (
        this.checkpointFailures.has(files.wal) &&
        this.oldest(reclaimable).some((entry) =>
          entry.device === device && this.evict(entry)
        )
      ) ({ filesystems } = await this.inventory());
      await this.observeScratch();
      const disk = filesystems.find((disk) => disk.device === device);
      if (!disk) throw new Error('checkpoint outside capacity roots');
      const dbBytes = await allocated(files.database) +
        await allocated(files.log) + await allocated(files.wal);
      const used = typeof this.budget === 'number'
        ? filesystems.reduce((sum, filesystem) => sum + filesystem.usedBytes, 0)
        : disk.usedBytes;
      return {
        observe: (peak) => {
          active.peakOvershootBytes = Math.max(
            active.peakOvershootBytes,
            used - dbBytes + peak - (disk.budgetBytes ?? Infinity),
          );
        },
        finish: (outcome) => {
          if (outcome === 'full') {
            this.checkpointFailures.set(files.wal, device);
          }
          if (outcome === 'completed') {
            this.checkpointFailures.delete(files.wal);
          }
          this.checkpointPeaks.set(device, active.peakOvershootBytes);
          this.checkpointActive = undefined;
          this.notifyRelease();
        },
      };
    } catch (error) {
      this.checkpointActive = undefined;
      this.notifyRelease();
      throw error;
    }
  }

  private async inventory(quotaPaths?: Map<FilesystemCapacity, string>) {
    const filesystems = new Map<string, FilesystemCapacity>();
    const reclaimable: Reclaimable[] = [];
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
    ) => {
      try {
        const entry = await lstat(path, { bigint: true });
        const device = String(entry.dev);
        const identity = `${device}:${entry.ino}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        // Never follow entries that link out of a managed root. The inode's
        // allocation belongs to the parent even when its target is elsewhere.
        const disk = entry.isSymbolicLink() || device === parentDevice
          ? parent
          : filesystem(
            await this.space({ path, device, original: path, target: path }),
            path,
          );
        const bytes = Number(entry.blocks * 512n);
        disk.usedBytes += bytes;
        const blob = this.cache.get(path);
        if (
          blob?.unleased() && entry.isFile() && entry.nlink === 1n &&
          blob.inode === entry.ino && blob.device === device
        ) {
          disk.reclaimableBytes += bytes;
          reclaimable.push({
            path,
            inode: entry.ino,
            device: disk.device,
            physicalDevice: device,
            bytes,
            blob,
          });
        } else disk.protectedBytes += bytes;
        if (entry.isDirectory()) {
          for await (const child of Deno.readDir(path)) {
            await visit(join(path, child.name), disk, device);
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
    for (const claim of this.claims) {
      const disk = filesystems.get(claim.device);
      if (disk) disk.reservedBytes += claim.bytes;
    }
    for (const disk of disks) {
      if (!disk.checkpoint.active) continue;
      const used = typeof this.budget === 'number'
        ? disks.reduce((sum, disk) => sum + disk.usedBytes, 0)
        : disk.usedBytes;
      const overshoot = Math.max(0, used - (disk.budgetBytes ?? Infinity));
      disk.checkpoint.overshootBytes = overshoot;
      disk.checkpoint.peakOvershootBytes = Math.max(
        disk.checkpoint.peakOvershootBytes,
        overshoot,
      );
    }
    return { filesystems: disks, reclaimable };
  }

  async status(probeQuota?: QuotaProbe) {
    const paths = probeQuota && new Map<FilesystemCapacity, string>();
    const { filesystems } = await this.inventory(paths);
    if (probeQuota && paths) {
      await Promise.all([...paths].map(async ([disk, path]) => {
        disk.quotaBackstop = await probeQuota(path);
      }));
    }
    const currentBytes = await this.observeScratch() ?? 0;
    return {
      filesystems,
      scratch: {
        currentBytes,
        observedPeakBytes: this.scratchObservedPeakBytes,
      },
    };
  }
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
  };
}

function claimedBytes(claims: readonly Claim[]): number {
  return claims.reduce((sum, claim) => sum + claim.bytes, 0);
}

function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${SEPARATOR}`) &&
    resolve(root, suffix) === path;
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
