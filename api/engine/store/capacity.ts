import { lstat, realpath, stat, statfs } from 'node:fs/promises';
import { dirname, join, resolve } from '@std/path';

type FilesystemCapacity = {
  device: string;
  totalBytes: number;
  freeBytes: number;
  freeInodes: number | null;
  budgetBytes: number;
  usedBytes: number;
  protectedBytes: number;
  reclaimableBytes: number;
  quotaBackstop: boolean;
};

function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** The facade's capacity inventory is keyed by filesystem, not by root. */
export class Capacity {
  constructor(private readonly roots: readonly string[]) {}

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
        budgetBytes: Number(total * 99n / 100n),
        usedBytes: 0,
        protectedBytes: 0,
        reclaimableBytes: 0,
        quotaBackstop: false,
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
    return { filesystems: [...filesystems.values()] };
  }
}
