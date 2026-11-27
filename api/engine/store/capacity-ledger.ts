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

/** Inventory assigns an inode to one device and counts its hard links once. */
export class CapacityLedger {
  readonly paths = new Map<string, Allocation>();
  private readonly inodes = new Map<
    string,
    { count: number; allocation: Allocation }
  >();
  private readonly devices = new Map<string, number>();
  total = 0;

  used(device: string): number {
    return this.devices.get(device) ?? 0;
  }

  private charge(device: string, bytes: number) {
    this.devices.set(device, this.used(device) + bytes);
    this.total += bytes;
  }

  set(path: string, allocation?: Allocation) {
    const key = (a: Allocation) => `${a.physicalDevice}:${a.inode}`;
    const old = this.paths.get(path);
    if (old) {
      const prior = this.inodes.get(key(old))!;
      if (--prior.count === 0) {
        this.charge(prior.allocation.device, -prior.allocation.bytes);
        this.inodes.delete(key(old));
      }
      this.paths.delete(path);
    }
    if (!allocation) return;
    const prior = this.inodes.get(key(allocation));
    if (prior) {
      prior.count++;
      this.charge(
        prior.allocation.device,
        allocation.bytes - prior.allocation.bytes,
      );
      this.paths.set(
        path,
        Object.assign(prior.allocation, {
          ...allocation,
          device: prior.allocation.device,
        }),
      );
    } else {
      const canonical = { ...allocation };
      this.inodes.set(key(allocation), { count: 1, allocation: canonical });
      this.paths.set(path, canonical);
      this.charge(allocation.device, allocation.bytes);
    }
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
