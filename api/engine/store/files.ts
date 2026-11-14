// Durable publication of caller-owned private staging, never operator data.
import { dirname, join } from '@std/path';
import type { Turso } from './ffi.ts';

export async function syncPath(path: string): Promise<void> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.sync();
  } finally {
    file.close();
  }
}

export async function removeOwned(path: string): Promise<void> {
  try {
    await Deno.remove(path, { recursive: true });
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

export async function syncTree(path: string): Promise<void> {
  const stat = await Deno.lstat(path);
  if (stat.isDirectory) {
    for await (const entry of Deno.readDir(path)) {
      await syncTree(join(path, entry.name));
    }
  } else if (!stat.isFile) {
    throw new Error('backup contains a non-regular filesystem entry');
  }
  await syncPath(path);
}

export async function copyPrivate(
  source: string,
  target: string,
): Promise<void> {
  const stat = await Deno.lstat(source);
  if (stat.isDirectory) {
    await Deno.mkdir(target, { mode: 0o700 });
    for await (const entry of Deno.readDir(source)) {
      await copyPrivate(join(source, entry.name), join(target, entry.name));
    }
    await syncPath(target);
    return;
  }
  if (!stat.isFile) {
    throw new Error('backup contains a non-regular filesystem entry');
  }
  const input = await Deno.open(source, { read: true });
  try {
    const output = await Deno.open(target, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    try {
      const chunk = new Uint8Array(65536);
      for (;;) {
        const count = await input.read(chunk);
        if (count === null) break;
        let written = 0;
        while (written < count) {
          written += await output.write(chunk.subarray(written, count));
        }
      }
      await output.sync();
    } finally {
      output.close();
    }
  } finally {
    input.close();
  }
}

export async function publish(
  ffi: Turso,
  source: string,
  destination: string,
): Promise<void> {
  await syncTree(source);
  if (await ffi.renameNoReplace(source, destination)) {
    await syncPath(dirname(destination));
    if (dirname(source) !== dirname(destination)) {
      await syncPath(dirname(source));
    }
    return;
  }
  // EXDEV: first copy privately on the destination filesystem, then rename.
  const stage = await Deno.makeTempDir({
    dir: dirname(destination),
    prefix: '.communico-publish-',
    suffix: '.new',
  });
  const copy = join(stage, 'data');
  try {
    await copyPrivate(source, copy);
    if (!await ffi.renameNoReplace(copy, destination)) {
      throw new Error('publication filesystem changed during copy');
    }
    await syncPath(dirname(destination));
    await Deno.remove(source, {
      recursive: (await Deno.lstat(source)).isDirectory,
    });
    await syncPath(dirname(source));
  } finally {
    await Deno.remove(stage, { recursive: true });
    await syncPath(dirname(destination));
  }
}
