import { basename, dirname, join, resolve } from '@std/path';

// A missing root is legal during an offline promotion. Resolve ownership from
// its stable parent, without creating the root or following an alias into it.
export async function canonicalRoot(root: string): Promise<string> {
  root = resolve(root);
  if (dirname(root) === root) {
    throw new Error('store root cannot be a filesystem root');
  }
  let path = root;
  for (;;) {
    try {
      const stat = await Deno.lstat(path);
      if (stat.isSymlink) throw new Error('store root has a symlink component');
      if (!stat.isDirectory) throw new Error('store root is not a directory');
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    const parent = dirname(path);
    if (parent === path) break;
    path = parent;
  }
  return root;
}

// Stable sibling: replacing a store root must not replace the lock inode.
export async function ownershipPath(root: string): Promise<string> {
  root = await canonicalRoot(root);
  const parent = await Deno.realPath(dirname(root));
  return join(parent, '.' + basename(root) + '.communico.lock');
}

export function promotionPath(root: string): string {
  root = resolve(root);
  return join(dirname(root), '.' + basename(root) + '.communico-restore.json');
}

export async function assertNoPromotion(root: string): Promise<void> {
  try {
    await Deno.lstat(promotionPath(root));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  throw new Error(
    'incomplete restore promotion: rerun the offline restore command to recover',
  );
}
