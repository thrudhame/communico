import { lstat, realpath, stat, statfs } from 'node:fs/promises';
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

type Claim = { device: string; bytes: number; inodes: number };
export type Reservation = { release(): void };
export type NativeReservation = Reservation & {
  blockSize: number;
  bytes: number;
  creates: number;
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
  private readonly claims = new Set<Claim>();
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

  /** Data-dependent native work gets an enforced ceiling, not a SQL estimate. */
  reserveNative(
    path: string,
    creates: number,
  ): Promise<NativeReservation> {
    return this.claim(path, { inodes: creates, metadataBlocks: creates * 5 });
  }

  private claim(
    path: string,
    footprint: {
      bytes?: number;
      inodes: number;
      metadataBlocks: number;
      files?: readonly number[];
    },
    publication = false,
  ): Promise<NativeReservation> {
    const result = this.lane.then(async () => {
      const { promise: released } = this.released;
      if (this.checkpointActive) throw new StorageBusyError(released);
      if (
        [
          footprint.bytes ?? 0,
          footprint.inodes,
          footprint.metadataBlocks,
          ...(footprint.files ?? []),
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
      const space = await this.space(at);
      const device = String(space.device);
      const snap = (await this.status()).filesystems;
      const disk = snap.find((disk) => disk.device === device);
      if (!disk && !publication) {
        throw new Error('reservation device outside capacity roots');
      }
      const blockSize = space.blockSize;
      const metadata = footprint.metadataBlocks * blockSize;
      const local = outstanding.filter((claim) => claim.device === device);
      const explicit = typeof this.budget === 'number';
      const used = explicit
        ? snap.reduce((sum, disk) => sum + disk.usedBytes, 0)
        : disk?.usedBytes ?? 0;
      const budget = disk
        ? disk.budgetBytes
        : this.budget === null
        ? null
        : this.budget ?? Math.floor(space.totalBytes * 0.99);
      const budgetLeft = (budget ?? Infinity) - used;
      const minimum = footprint.bytes === undefined
        ? 0
        : [footprint.bytes, ...(footprint.files ?? [])].reduce(
          (sum, size) => sum + Math.ceil(size / blockSize) * blockSize,
          0,
        );
      const inodesLeft = space.freeInodes ?? Infinity;
      const needs = minimum + metadata;
      // Actual exhaustion is independent of claims. A data-dependent native
      // operation needs its metadata up front; it can only use a checked
      // ceiling on payload, not a guessed SQL byte cost.
      if (
        needs > Math.min(space.freeBytes, budgetLeft) ||
        footprint.inodes > inodesLeft
      ) throw new StoragePressureError();
      const available = Math.min(
        space.freeBytes - claimedBytes(local),
        budgetLeft - claimedBytes(explicit ? outstanding : local),
      );
      if (
        this.checkpointActive || needs > available ||
        footprint.inodes > inodesLeft -
            local.reduce((sum, claim) => sum + claim.inodes, 0)
      ) throw new StorageBusyError(released);
      const data = footprint.bytes === undefined
        ? Math.floor((available - metadata) / blockSize) * blockSize
        : minimum;
      const claim = {
        device,
        bytes: data + metadata,
        inodes: footprint.inodes,
      };
      this.claims.add(claim);
      return {
        release: () => {
          if (this.claims.delete(claim)) this.notifyRelease();
        },
        blockSize,
        bytes: data,
        creates: footprint.inodes,
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
      return await write();
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
      const { filesystems } = await this.status();
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

  async status(): Promise<{
    filesystems: FilesystemCapacity[];
    scratch: { currentBytes: number; observedPeakBytes: number };
  }> {
    const filesystems = new Map<string, FilesystemCapacity>();
    const seen = new Set<string>();
    const filesystem = (space: Space) => {
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
          );
        const bytes = Number(entry.blocks * 512n);
        disk.usedBytes += bytes;
        // Until the cache owner can vouch for eviction, treat bytes as protected.
        disk.protectedBytes += bytes;
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
      const disk = filesystem(await this.space(at));
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
    const currentBytes = await this.observeScratch() ?? 0;
    return {
      filesystems: disks,
      scratch: {
        currentBytes,
        observedPeakBytes: this.scratchObservedPeakBytes,
      },
    };
  }
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
