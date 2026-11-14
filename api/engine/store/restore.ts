// Offline filesystem lifecycle only. The engine validates/migrates/sanitizes
// candidates and completes its report before requesting promotion. No app,
// database startup hook or worker is opened here.
import { basename, dirname, join } from '@std/path';
import { checkBuildInfo } from './build.ts';
import { removeOwned, syncPath, syncTree } from './files.ts';
import { Turso } from './ffi.ts';
import type { StoreConfig } from './index.ts';
import { canonicalRoot, ownershipPath, promotionPath } from './ownership.ts';

type Identity = { dev: number; ino: number };
type Root = {
  path: string;
  candidate: string;
  previous: string;
  old: Identity | null;
  fresh: Identity;
};
type Journal = { format: 1; id: string; roots: [Root, Root] };

export type RestoreTarget = {
  readonly store: string;
  readonly media: string;
  promote(): Promise<{ store: string | null; media: string | null }>;
};

async function identity(path: string): Promise<Identity | null> {
  try {
    const stat = await Deno.lstat(path);
    if (!stat.isDirectory || stat.isSymlink) {
      throw new Error('restore promotion: non-directory or symlink root');
    }
    return { dev: stat.dev, ino: stat.ino! };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return null;
    throw error;
  }
}

function equal(a: Identity | null, b: Identity | null): boolean {
  return a === null || b === null
    ? a === b
    : a.dev === b.dev && a.ino === b.ino;
}

function paths(path: string, id: string) {
  const base = '.' + basename(path);
  return {
    path,
    candidate: join(dirname(path), base + '.restore-' + id + '.new'),
    previous: join(dirname(path), base + '.replaced-' + id),
  };
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

async function nonempty(path: string): Promise<boolean> {
  if (await identity(path) === null) return false;
  for await (const _entry of Deno.readDir(path)) return true;
  return false;
}

async function move(ffi: Turso, from: string, to: string): Promise<void> {
  if (!await ffi.renameNoReplace(from, to)) {
    throw new Error(
      'restore promotion: candidate must share its target filesystem',
    );
  }
  await syncPath(dirname(to));
}

async function writeJournal(
  ffi: Turso,
  path: string,
  journal: Journal,
): Promise<void> {
  const stage = await Deno.makeTempDir({
    dir: dirname(path),
    prefix: '.communico-restore-journal-',
  });
  try {
    const record = join(stage, 'record.json');
    const file = await Deno.open(record, {
      createNew: true,
      write: true,
      mode: 0o600,
    });
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(journal) + '\n');
      let offset = 0;
      while (offset < bytes.length) {
        offset += await file.write(bytes.subarray(offset));
      }
      await file.sync();
    } finally {
      file.close();
    }
    await move(ffi, record, path);
  } finally {
    await removeOwned(stage);
  }
}

function validIdentity(value: unknown): value is Identity {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Identity;
  return Number.isSafeInteger(v.dev) && v.dev >= 0 &&
    Number.isSafeInteger(v.ino) && v.ino > 0;
}

async function readJournal(
  path: string,
  targets: [string, string],
): Promise<Journal> {
  const stat = await Deno.lstat(path);
  if (!stat.isFile || stat.isSymlink) {
    throw new Error('restore promotion: invalid journal file');
  }
  const journal = JSON.parse(await Deno.readTextFile(path)) as Journal;
  if (
    journal?.format !== 1 || typeof journal.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      .test(journal.id) ||
    !Array.isArray(journal.roots) || journal.roots.length !== 2
  ) throw new Error('restore promotion: invalid journal');
  for (let i = 0; i < 2; i++) {
    const root = journal.roots[i];
    const expected = paths(targets[i], journal.id);
    if (
      root?.path !== expected.path || root.candidate !== expected.candidate ||
      root.previous !== expected.previous || !validIdentity(root.fresh) ||
      (root.old !== null && !validIdentity(root.old)) ||
      equal(root.old, root.fresh)
    ) throw new Error('restore promotion: journal target/identity mismatch');
  }
  return journal;
}

// The durable journal is an undo record, not a request to serve a half-restored
// pair. Normal startup refuses it. An explicit offline retry restores both old
// roots, including the originally-absent case, before attempting another restore.
async function recover(
  ffi: Turso,
  journalPath: string,
  targets: [string, string],
): Promise<void> {
  if (!await exists(journalPath)) return;
  const journal = await readJournal(journalPath, targets);
  // Validate the entire pair before moving anything. Inodes, not path existence,
  // distinguish pre/post-rename windows and interrupted recovery itself.
  const states = [];
  for (const root of journal.roots) {
    await canonicalRoot(root.path);
    const current = await identity(root.path);
    const staged = await identity(root.candidate);
    const previous = await identity(root.previous);
    const freshAtRoot = equal(current, root.fresh) && staged === null;
    const freshAtStage = equal(staged, root.fresh) &&
      !equal(current, root.fresh);
    const oldAtRoot = equal(current, root.old) && previous === null;
    const oldSaved = current === null || freshAtRoot;
    if (
      (!freshAtRoot && !freshAtStage) ||
      (!oldAtRoot && !(oldSaved && equal(previous, root.old)))
    ) {
      throw new Error(
        'restore promotion: roots changed; refusing unsafe recovery',
      );
    }
    states.push({ root, freshAtRoot });
  }
  for (const { root, freshAtRoot } of states) {
    if (freshAtRoot) await move(ffi, root.path, root.candidate);
    if (root.old !== null && await identity(root.path) === null) {
      await move(ffi, root.previous, root.path);
    }
  }
  await Deno.remove(journalPath);
  await syncPath(dirname(journalPath));
  for (const root of journal.roots) {
    await removeOwned(root.candidate);
    await syncPath(dirname(root.candidate));
  }
}

export async function withRestoreTarget<T>(
  config: Pick<StoreConfig, 'dir' | 'library'>,
  media: string,
  options: { replace?: boolean },
  prepare: (target: RestoreTarget) => Promise<T>,
): Promise<T> {
  const store = await canonicalRoot(config.dir);
  media = await canonicalRoot(media);
  if (overlaps(store, media)) {
    throw new Error('restore store/media roots overlap');
  }
  await Deno.mkdir(dirname(store), { recursive: true, mode: 0o700 });
  await Deno.mkdir(dirname(media), { recursive: true, mode: 0o700 });
  const ffi = new Turso(config.library);
  const journalPath = promotionPath(store);
  let ownership: number | undefined;
  const roots: Root[] = [];
  let promoted = false;
  let active = true;
  let promotion:
    | Promise<{ store: string | null; media: string | null }>
    | undefined;
  try {
    checkBuildInfo(await ffi.buildInfo());
    ownership = await ffi.lockStore(await ownershipPath(store));
    await recover(ffi, journalPath, [store, media]);
    if (!options.replace && (await nonempty(store) || await nonempty(media))) {
      throw new Error(
        'restore target is nonempty; explicit --replace is required',
      );
    }
    const id = crypto.randomUUID();
    for (const path of [store, media]) {
      const names = paths(path, id);
      await Deno.mkdir(names.candidate, { mode: 0o700 });
      roots.push({
        ...names,
        old: await identity(path),
        fresh: (await identity(names.candidate))!,
      });
    }
    return await prepare({
      store: roots[0].candidate,
      media: roots[1].candidate,
      promote() {
        if (!active || promoted || promotion) {
          return Promise.reject(new Error('restore candidate is closed'));
        }
        promotion = (async () => {
          if (
            !options.replace && (await nonempty(store) || await nonempty(media))
          ) {
            throw new Error(
              'restore target is nonempty; explicit --replace is required',
            );
          }
          for (const root of roots) {
            await canonicalRoot(root.path);
            if (
              !equal(await identity(root.path), root.old) ||
              !equal(await identity(root.candidate), root.fresh) ||
              await exists(root.previous)
            ) {
              throw new Error(
                'restore target changed during candidate preparation',
              );
            }
            await syncTree(root.candidate);
            await syncPath(dirname(root.candidate));
          }
          await writeJournal(ffi, journalPath, {
            format: 1,
            id,
            roots: roots as [Root, Root],
          });
          for (const root of roots) {
            if (root.old !== null) await move(ffi, root.path, root.previous);
            await move(ffi, root.candidate, root.path);
          }
          await Deno.remove(journalPath);
          await syncPath(dirname(journalPath));
          promoted = true;
          return {
            store: roots[0].old === null ? null : roots[0].previous,
            media: roots[1].old === null ? null : roots[1].previous,
          };
        })();
        return promotion;
      },
    });
  } finally {
    active = false;
    if (promotion) await Promise.allSettled([promotion]);
    try {
      // If publication was interrupted, the undo record and every root remain
      // for offline recovery. Never remove prior operator data.
      if (!await exists(journalPath)) {
        for (const root of roots) await removeOwned(root.candidate);
      }
    } finally {
      if (ownership !== undefined) await ffi.unlockStore(ownership);
      ffi.close();
    }
  }
}
