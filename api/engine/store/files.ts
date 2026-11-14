// Durable publication of caller-owned private staging, never operator data.
import { dirname, join } from '@std/path';
import type { Turso } from './ffi.ts';
import { type FileHandle, open } from 'node:fs/promises';
import { constants } from 'node:fs';

export type InputFile = Pick<Deno.FileInfo, 'dev' | 'ino' | 'uid' | 'mode'>;

// The caller owns the returned descriptor. Metadata, policy and reads can all
// refer to this one pinned file, including under scoped Deno permissions.
export async function openRegularFile(source: string) {
  let file: FileHandle | undefined;
  try {
    file = await open(
      source,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const entry = await Deno.lstat(source);
    const stat = await file.stat();
    if (!entry.isFile || !stat.isFile()) {
      throw new Error('backup source must be a regular file');
    }
    if (entry.dev !== stat.dev || entry.ino !== stat.ino) {
      throw new Error('backup source changed while opening');
    }
    return { file, stat };
  } catch (error) {
    const code = error instanceof Error && 'code' in error
      ? error.code
      : undefined;
    const failure = code === 'ELOOP'
      ? new Error('backup source must be a regular file', { cause: error })
      : code === 'ENOENT'
      ? new Deno.errors.NotFound(
        error instanceof Error ? error.message : 'backup source not found',
      )
      : error;
    try {
      await file?.close();
    } catch (close) {
      throw new AggregateError(
        [failure, close],
        'backup source validation and close failed',
      );
    }
    throw failure;
  }
}

export async function copyPrivateFile(
  source: string,
  target: string,
  validate?: (file: InputFile) => void,
): Promise<void> {
  const { file: input, stat } = await openRegularFile(source);
  try {
    validate?.(stat);
    const output = await Deno.open(target, {
      write: true,
      createNew: true,
      mode: 0o600,
    });
    try {
      const chunk = new Uint8Array(65536);
      for (;;) {
        const { bytesRead } = await input.read(chunk, 0, chunk.length, null);
        if (bytesRead === 0) break;
        let written = 0;
        while (written < bytesRead) {
          const count = await output.write(chunk.subarray(written, bytesRead));
          if (count <= 0) throw new Error('short backup copy write');
          written += count;
        }
      }
      await output.sync();
    } finally {
      output.close();
    }
  } finally {
    await input.close();
  }
}

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
  await copyPrivateFile(source, target);
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
