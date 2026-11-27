import { dirname, relative, resolve, SEPARATOR } from '@std/path';

export function contains(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '..' && !suffix.startsWith(`..${SEPARATOR}`) &&
    resolve(root, suffix) === path;
}

export type Allocation = {
  device: string;
  physicalDevice: string;
  inode: bigint;
  bytes: number;
  links: bigint;
  directory: boolean;
  symlink: boolean;
};

const identity = (allocation: Allocation) =>
  `${allocation.physicalDevice}:${allocation.inode}`;

/** Inventory assigns an inode to one device and counts its hard links once. */
export class CapacityLedger {
  readonly paths = new Map<string, Allocation>();
  private readonly inodes = new Map<
    string,
    { count: number; allocation: Allocation }
  >();
  private readonly devices = new Map<string, number>();
  private changedInodes?: Set<string>;
  total = 0;

  used(device: string): number {
    return this.devices.get(device) ?? 0;
  }

  private charge(device: string, bytes: number) {
    this.devices.set(device, this.used(device) + bytes);
    this.total += bytes;
  }

  private update(current: Allocation, latest: Allocation) {
    this.charge(current.device, latest.bytes - current.bytes);
    Object.assign(current, { ...latest, device: current.device });
  }

  set(path: string, allocation?: Allocation) {
    const old = this.paths.get(path);
    if (old) {
      const key = identity(old);
      this.changedInodes?.add(key);
      const prior = this.inodes.get(key)!;
      if (--prior.count === 0) {
        this.charge(prior.allocation.device, -prior.allocation.bytes);
        this.inodes.delete(key);
      }
      this.paths.delete(path);
    }
    if (!allocation) return;
    const key = identity(allocation);
    this.changedInodes?.add(key);
    const prior = this.inodes.get(key);
    if (prior) {
      prior.count++;
      this.update(prior.allocation, allocation);
      this.paths.set(path, prior.allocation);
    } else {
      const canonical = { ...allocation };
      this.inodes.set(key, { count: 1, allocation: canonical });
      this.paths.set(path, canonical);
      this.charge(allocation.device, allocation.bytes);
    }
  }

  beginScan() {
    const changed = this.changedInodes = new Set<string>();
    return {
      merge: (fresh: CapacityLedger, paths: Iterable<string>) => {
        // Settle names first. A deleted name must not hide a newer charge
        // for the same inode still reachable through a different name.
        for (const path of paths) fresh.set(path, this.paths.get(path));
        for (const key of changed) {
          const live = this.inodes.get(key);
          const scanned = fresh.inodes.get(key);
          if (live && scanned) {
            fresh.update(scanned.allocation, live.allocation);
          }
        }
      },
      close: () => {
        this.changedInodes = undefined;
      },
    };
  }

  /** Moving a name cannot update the observed allocation of its inode. */
  move(source: string, destination: string): void {
    if (source === destination) return;
    const entry = this.paths.get(source);
    if (!entry) return;
    this.set(destination);
    this.paths.set(destination, entry);
    this.paths.delete(source);
  }

  /** Look up the nearest known directory without filesystem I/O. */
  location(path: string): { path: string; allocation: Allocation } | undefined {
    for (let at = path;; at = dirname(at)) {
      const allocation = this.paths.get(at);
      if (allocation?.symlink) {
        throw new Error('reservation through a managed symlink');
      }
      if (allocation?.directory) return { path: at, allocation };
      if (at === dirname(at)) return;
    }
  }
}
