import { lstat, realpath, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from '@std/path';
import { databaseFiles } from '#engine/store/layout.ts';

type FilesystemCapacity = {
  device: string;
  totalBytes: number;
  freeBytes: number;
  freeInodes: number | null;
  budgetBytes: number | null;
  usedBytes: number;
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
  private checkpointActive?: { device?: string; peakOvershootBytes: number };
  private readonly checkpointPeaks = new Map<string, number>();
  private readonly checkpointFailures = new Map<string, string>();

  constructor(
    private readonly roots: readonly string[],
    private readonly budget?: number | null,
  ) {}

  /** Never wait here: the file gate already has ordinary transactions paused. */
  async tryCheckpoint(path: string): Promise<
    {
      observe(peakBytes: number): void;
      finish(outcome?: 'full' | 'completed'): void;
    } | undefined
  > {
    // Globally exclusive: an explicit budget is shared across devices. The
    // same lease will also fence the ordinary reservation ledger.
    if (this.checkpointActive) return;
    const active: NonNullable<Capacity['checkpointActive']> = {
      peakOvershootBytes: 0,
    };
    this.checkpointActive = active;
    try {
      const files = databaseFiles(dirname(path));
      const entry = await stat(path, { bigint: true });
      const device = active.device = String(entry.dev);
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
        },
      };
    } catch (error) {
      this.checkpointActive = undefined;
      throw error;
    }
  }

  async status(): Promise<{ filesystems: FilesystemCapacity[] }> {
    const filesystems = new Map<string, FilesystemCapacity>();
    const seen = new Set<string>();
    const filesystem = async (path: string, device: string) => {
      const known = filesystems.get(device);
      if (known) return known;
      const fs = await statfs(path, { bigint: true });
      const total = fs.blocks * fs.bsize;
      const disk: FilesystemCapacity = {
        device,
        totalBytes: Number(total),
        freeBytes: Number(fs.bavail * fs.bsize),
        freeInodes: fs.files === 0n ? null : Number(fs.ffree),
        budgetBytes: this.budget === null
          ? null
          : this.budget ?? Number(total * 99n / 100n),
        usedBytes: 0,
        protectedBytes: 0,
        reclaimableBytes: 0,
        quotaBackstop: false,
        filesystemFull: fs.bavail === 0n ||
          (fs.files !== 0n && fs.ffree === 0n),
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
    const visit = async (path: string, parent: FilesystemCapacity) => {
      try {
        const entry = await lstat(path, { bigint: true });
        const device = String(entry.dev);
        const identity = `${device}:${entry.ino}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        // Never follow entries that link out of a managed root. The inode's
        // allocation belongs to the parent even when its target is elsewhere.
        const disk = entry.isSymbolicLink()
          ? parent
          : await filesystem(path, device);
        const bytes = Number(entry.blocks * 512n);
        disk.usedBytes += bytes;
        // Until the cache owner can vouch for eviction, treat bytes as protected.
        disk.protectedBytes += bytes;
        if (entry.isDirectory()) {
          for await (const child of Deno.readDir(path)) {
            await visit(join(path, child.name), disk);
          }
        }
      } catch (error) {
        if (!missing(error) && !(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    };
    for (const root of this.roots) {
      let ancestor = resolve(root);
      for (;;) {
        try {
          const path = await realpath(ancestor);
          const entry = await stat(path, { bigint: true });
          const disk = await filesystem(path, String(entry.dev));
          // A missing root still belongs to its parent's filesystem, but the
          // parent's own data is not part of the facade's inventory.
          if (ancestor === resolve(root)) await visit(path, disk);
          break;
        } catch (error) {
          const parent = dirname(ancestor);
          if (!missing(error) || parent === ancestor) throw error;
          ancestor = parent;
        }
      }
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
        ? disks.reduce((sum, disk) => sum + disk.usedBytes, 0)
        : disk.usedBytes;
      const overshoot = Math.max(0, used - (disk.budgetBytes ?? Infinity));
      disk.checkpoint.overshootBytes = overshoot;
      disk.checkpoint.peakOvershootBytes = Math.max(
        disk.checkpoint.peakOvershootBytes,
        overshoot,
      );
    }
    return { filesystems: disks };
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
