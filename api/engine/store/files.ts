// Durable publication of caller-owned private staging, never operator data.
import { dirname, join, relative } from '@std/path';
import type { Turso } from './ffi.ts';
import { type FileHandle, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { Capacity } from './capacity.ts';
import { storageFailure } from './pressure.ts';

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

export async function removeOwned(
  path: string,
  capacity?: Capacity,
): Promise<void> {
  try {
    if (capacity) await capacity.remove(path, { recursive: true });
    else await Deno.remove(path, { recursive: true });
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
  track?: (path: string) => void,
): Promise<void> {
  const stat = await Deno.lstat(source);
  track?.(target);
  if (stat.isDirectory) {
    await Deno.mkdir(target, { mode: 0o700 });
    for await (const entry of Deno.readDir(source)) {
      await copyPrivate(
        join(source, entry.name),
        join(target, entry.name),
        track,
      );
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
  capacity?: Capacity,
): Promise<void> {
  await syncTree(source);
  const rename = await capacity?.reservePublication(destination, 0, []);
  try {
    if (await ffi.renameNoReplace(source, destination)) {
      capacity?.moved(source, destination);
      await syncPath(dirname(destination));
      if (dirname(source) !== dirname(destination)) {
        await syncPath(dirname(source));
      }
      return;
    }
  } catch (error) {
    throw storageFailure(error);
  } finally {
    rename?.release();
  }
  // EXDEV: first copy privately on the destination filesystem, then rename.
  const duplicate = capacity
    ? await copyReservation(capacity, source, destination)
    : undefined;
  let stage: string | undefined;
  try {
    stage = join(
      dirname(destination),
      `.communico-publish-${crypto.randomUUID()}.new`,
    );
    duplicate?.track(stage);
    await Deno.mkdir(stage, { mode: 0o700 });
    const copy = join(stage, 'data');
    await copyPrivate(source, copy, (path) => {
      duplicate?.track(path, join(destination, relative(copy, path)));
    });
    if (!await ffi.renameNoReplace(copy, destination)) {
      throw new Error('publication filesystem changed during copy');
    }
    await syncPath(dirname(destination));
    await removeOwned(source, capacity);
    await syncPath(dirname(source));
  } catch (error) {
    throw storageFailure(error);
  } finally {
    try {
      if (stage !== undefined) {
        await removeOwned(stage, capacity);
        await syncPath(dirname(destination));
      }
    } finally {
      duplicate?.release();
    }
  }
}

async function copyReservation(
  capacity: Capacity,
  source: string,
  destination: string,
) {
  let inodes = 1; // The private destination-side staging directory.
  const files: number[] = [];
  async function visit(path: string) {
    const stat = await Deno.lstat(path);
    inodes++;
    if (stat.isFile) files.push(stat.size);
    else if (stat.isDirectory) {
      for await (const entry of Deno.readDir(path)) {
        await visit(join(path, entry.name));
      }
    } else throw new Error('backup contains a non-regular filesystem entry');
  }
  await visit(source);
  return await capacity.reservePublication(destination, inodes, files);
}
