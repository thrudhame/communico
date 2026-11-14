import { basename, dirname, join, resolve } from '@std/path';

// Stable sibling: replacing a store root must not replace the lock inode.
export async function ownershipPath(root: string): Promise<string> {
  root = resolve(root);
  const parent = await Deno.realPath(dirname(root));
  return join(parent, '.' + basename(root) + '.communico.lock');
}
