import { join } from '@std/path';
import type { Capacity } from './capacity.ts';

const scratchVariables = ['TURSO_TMPDIR', 'TMPDIR'] as const;
let routing = false;

// A native TEMP database uses TURSO_TMPDIR; ephemeral tables and sorter spill
// use TMPDIR. These are process-wide, so two managed stores cannot route to
// different roots concurrently. Do not redirect a live store's scratch IO.
export async function routeStoreScratch(
  dataRoot: string,
  capacity: Capacity,
): Promise<() => void> {
  if (routing) throw new Error('managed store scratch is already routed');
  routing = true;
  try {
    const scratch = join(dataRoot, '.scratch');
    await capacity.ensureDirectory(scratch, 0o700);
    if (!(await Deno.lstat(scratch)).isDirectory) {
      throw new Error('managed store scratch root is not a directory');
    }
    const previous = scratchVariables.map((key) => Deno.env.get(key));
    const restore = () => {
      for (const [at, key] of scratchVariables.entries()) {
        const value = previous[at];
        if (value === undefined) Deno.env.delete(key);
        else Deno.env.set(key, value);
      }
      routing = false;
    };
    try {
      for (const key of scratchVariables) Deno.env.set(key, scratch);
      capacity.setScratchRoot(scratch);
    } catch (error) {
      restore();
      throw error;
    }
    return restore;
  } catch (error) {
    routing = false;
    throw error;
  }
}
