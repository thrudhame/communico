import { assert, assertEquals, assertRejects } from '@std/assert';
import { basename, dirname, join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { withRestoreTarget } from '#engine/store/restore.ts';

function config(dir: string) {
  return {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
}

Deno.test('store restore: a target populated during preparation still needs explicit replacement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-recheck-' });
  const dir = join(root, 'store');
  const media = join(root, 'media');
  await Deno.mkdir(dir);
  try {
    await assertRejects(
      () =>
        withRestoreTarget(config(dir), media, {}, async (target) => {
          await Deno.writeTextFile(join(dir, 'new-operator-data'), 'keep me');
          return await target.promote();
        }),
      Error,
      '--replace',
    );
    assertEquals(
      await Deno.readTextFile(join(dir, 'new-operator-data')),
      'keep me',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: starting a contender cannot recreate an absent root while offline ownership is held', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-missing-owner-' });
  const dir = join(root, 'store');
  try {
    await withRestoreTarget(config(dir), join(root, 'media'), {}, async () => {
      await assertRejects(() => openStore(config(dir)), Error, 'owned');
      await assertRejects(() => Deno.lstat(dir), Deno.errors.NotFound);
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: startup refuses a pending promotion before creating either database root', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-guard-' });
  try {
    const dir = join(root, 'store');
    const journal = join(root, '.store.communico-restore.json');
    await Deno.writeTextFile(journal, '{"interrupted":true}');
    await assertRejects(
      async () => {
        const store = await openStore(config(dir));
        await store.close();
      },
      Error,
      'restore promotion',
    );
    await assertRejects(() => Deno.lstat(dir), Deno.errors.NotFound);
    assertEquals(await Deno.readTextFile(journal), '{"interrupted":true}');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: startup cannot alias the ownership lock through a symlink root', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-alias-' });
  try {
    await Deno.mkdir(join(root, 'real'));
    await Deno.symlink(join(root, 'real'), join(root, 'alias'));
    await assertRejects(
      async () => {
        const store = await openStore(config(join(root, 'alias')));
        await store.close();
      },
      Error,
      'symlink',
    );
    assertEquals([...Deno.readDirSync(join(root, 'real'))], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: both offline and live owners retain the same lock even with explicit replacement', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-owner-' });
  const dir = join(root, 'store');
  const media = join(root, 'media');
  const store = await openStore(config(dir));
  try {
    await assertRejects(
      () =>
        withRestoreTarget(config(dir), media, { replace: true }, () => {
          throw new Error('must not reach candidate preparation');
        }),
      Error,
      'owned',
    );
    await store.close();
    await withRestoreTarget(
      config(dir),
      media,
      { replace: true },
      async (target) => {
        await assertRejects(() => openStore(config(dir)), Error, 'owned');
        await assertRejects(
          () =>
            withRestoreTarget(
              config(dir),
              media,
              { replace: true },
              async () => {},
            ),
          Error,
          'owned',
        );
        await Deno.writeTextFile(join(target.store, 'prepared'), 'private', {
          mode: 0o600,
        });
        assertEquals((await Deno.stat(target.store)).mode! & 0o777, 0o700);
        assertEquals(
          await Deno.readTextFile(join(target.store, 'prepared')),
          'private',
        );
      },
    );
    const reopened = await openStore(config(dir));
    await reopened.close();
    assertEquals(
      [...Deno.readDirSync(root)].filter((e) => e.name.includes('.restore-')),
      [],
    );
  } finally {
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: nonempty media alone refuses, replacement preserves both originals, and a second restore needs explicit replacement', async () => {
  const root = await Deno.makeTempDir({ prefix: "restore's-target-" });
  const dir = join(root, 'store');
  const media = join(root, 'media');
  await Deno.mkdir(media);
  await Deno.writeTextFile(join(media, 'old'), 'old media');
  try {
    await assertRejects(
      () => withRestoreTarget(config(dir), media, {}, async () => {}),
      Error,
      '--replace',
    );
    await assertRejects(() => Deno.lstat(dir), Deno.errors.NotFound);
    await Deno.mkdir(dir);
    await Deno.writeTextFile(join(dir, 'old'), 'old store');
    const saved = await withRestoreTarget(
      config(dir),
      media,
      { replace: true },
      async (target) => {
        await Deno.writeTextFile(join(target.store, 'new'), 'new store', {
          mode: 0o600,
        });
        await Deno.writeTextFile(join(target.media, 'new'), 'new media', {
          mode: 0o600,
        });
        return await target.promote();
      },
    );
    assert(saved.store && saved.media);
    assertEquals(
      await Deno.readTextFile(join(saved.store, 'old')),
      'old store',
    );
    assertEquals(
      await Deno.readTextFile(join(saved.media, 'old')),
      'old media',
    );
    assertEquals(await Deno.readTextFile(join(dir, 'new')), 'new store');
    assertEquals(await Deno.readTextFile(join(media, 'new')), 'new media');
    assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
    await assertRejects(
      () => withRestoreTarget(config(dir), media, {}, async () => {}),
      Error,
      '--replace',
    );
    await assertRejects(
      () => Deno.lstat(join(root, '.store.communico-restore.json')),
      Deno.errors.NotFound,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: empty targets and separate missing parent paths can be promoted, but aliases and overlapping roots cannot', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-paths-' });
  try {
    const dir = join(root, 'new-store-parent', 'store');
    const media = join(root, 'new-media-parent', 'media');
    const saved = await withRestoreTarget(
      config(dir),
      media,
      {},
      async (target) => {
        await Deno.writeTextFile(join(target.store, 'new'), 'new store');
        await Deno.writeTextFile(join(target.media, 'new'), 'new media');
        return await target.promote();
      },
    );
    assertEquals(saved, { store: null, media: null });
    await assertRejects(
      () =>
        withRestoreTarget(
          config(dir),
          join(dir, 'media'),
          { replace: true },
          async () => {},
        ),
      Error,
      'overlap',
    );
    await Deno.symlink(dirname(dir), join(root, 'alias'));
    await assertRejects(
      () =>
        withRestoreTarget(config(join(root, 'alias', 'store')), media, {
          replace: true,
        }, async () => {}),
      Error,
      'symlink',
    );
    const empty = join(root, 'empty');
    await Deno.mkdir(empty);
    const retained = await withRestoreTarget(
      config(empty),
      join(root, 'empty-media'),
      {},
      (target) => target.promote(),
    );
    assert(retained.store);
    assertEquals([...Deno.readDirSync(retained.store)], []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function interrupted(
  root: string,
  present: [boolean, boolean],
  states: [number, number],
) {
  const id = crypto.randomUUID();
  const roots = [];
  for (let i = 0; i < 2; i++) {
    const path = join(root, i === 0 ? 'store' : 'media');
    const candidate = join(
      root,
      '.' + basename(path) + '.restore-' + id + '.new',
    );
    const previous = join(root, '.' + basename(path) + '.replaced-' + id);
    await Deno.mkdir(candidate);
    await Deno.writeTextFile(join(candidate, 'new'), 'new ' + i);
    const freshStat = await Deno.stat(candidate);
    let old = null;
    if (present[i]) {
      await Deno.mkdir(path);
      await Deno.writeTextFile(join(path, 'old'), 'old ' + i);
      const st = await Deno.stat(path);
      old = { dev: st.dev, ino: st.ino };
    }
    roots.push({
      path,
      candidate,
      previous,
      old,
      fresh: { dev: freshStat.dev, ino: freshStat.ino },
    });
    if (states[i] >= 1 && present[i]) await Deno.rename(path, previous);
    if (states[i] === 2) await Deno.rename(candidate, path);
  }
  const journal = join(root, '.store.communico-restore.json');
  await Deno.writeTextFile(journal, JSON.stringify({ format: 1, id, roots }), {
    mode: 0o600,
  });
  return { roots, journal };
}

Deno.test('store restore: every durable rename and interrupted rollback window recovers the original pair, including absent roots', async (t) => {
  for (
    const present of [[true, true], [false, false], [true, false], [
      false,
      true,
    ]] as [boolean, boolean][]
  ) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) {
        await t.step(`${present.join('/')} windows ${a}/${b}`, async () => {
          const root = await Deno.makeTempDir({ prefix: 'restore-window-' });
          try {
            const f = await interrupted(root, present, [a, b]);
            const dir = f.roots[0].path;
            const media = f.roots[1].path;
            await assertRejects(
              () => openStore(config(dir)),
              Error,
              'restore promotion',
            );
            await assertRejects(
              () =>
                withRestoreTarget(
                  config(dir),
                  media,
                  { replace: true },
                  async () => {
                    for (let i = 0; i < 2; i++) {
                      if (present[i]) {
                        assertEquals(
                          await Deno.readTextFile(join(f.roots[i].path, 'old')),
                          'old ' + i,
                        );
                      } else {await assertRejects(
                          () => Deno.lstat(f.roots[i].path),
                          Deno.errors.NotFound,
                        );}
                    }
                    throw new Error('stop after recovery');
                  },
                ),
              Error,
              'stop after recovery',
            );
            await assertRejects(
              () => Deno.lstat(f.journal),
              Deno.errors.NotFound,
            );
            for (const r of f.roots) {
              await assertRejects(
                () => Deno.lstat(r.previous),
                Deno.errors.NotFound,
              );
              await assertRejects(
                () => Deno.lstat(r.candidate),
                Deno.errors.NotFound,
              );
            }
          } finally {
            await Deno.remove(root, { recursive: true });
          }
        });
      }
    }
  }
});

Deno.test('store restore: tampered journal paths or root identities refuse without moving either root', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-tamper-' });
  try {
    const f = await interrupted(root, [true, true], [2, 2]);
    await Deno.rename(f.roots[1].previous, join(root, 'operator-kept-media'));
    await Deno.mkdir(f.roots[1].previous);
    await assertRejects(
      () =>
        withRestoreTarget(config(f.roots[0].path), f.roots[1].path, {
          replace: true,
        }, async () => {}),
      Error,
      'unsafe recovery',
    );
    for (let i = 0; i < 2; i++) {
      assertEquals(
        await Deno.readTextFile(join(f.roots[i].path, 'new')),
        'new ' + i,
      );
    }
    const journal = JSON.parse(await Deno.readTextFile(f.journal));
    journal.roots[1].path = root;
    await Deno.writeTextFile(f.journal, JSON.stringify(journal));
    await assertRejects(
      () =>
        withRestoreTarget(config(f.roots[0].path), f.roots[1].path, {
          replace: true,
        }, async () => {}),
      Error,
      'mismatch',
    );
    assertEquals(
      await Deno.readTextFile(join(f.roots[0].previous, 'old')),
      'old 0',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store restore: a real failure between root promotions fences startup until the next offline recovery', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-failure-' });
  const dir = join(root, 'store');
  const media = join(root, 'media');
  for (const path of [dir, media]) {
    await Deno.mkdir(path);
    await Deno.writeTextFile(join(path, 'old'), 'prior');
  }
  const original = Deno.open;
  let injected = false;
  try {
    await assertRejects(
      () =>
        withRestoreTarget(
          config(dir),
          media,
          { replace: true },
          async (target) => {
            await Deno.writeTextFile(join(target.store, 'new'), 'candidate');
            await Deno.writeTextFile(join(target.media, 'new'), 'candidate');
            Deno.open = (async (...args: Parameters<typeof Deno.open>) => {
              if (!injected && args[0] === root) {
                try {
                  await Deno.lstat(join(dir, 'new'));
                  injected = true;
                  throw new Error('injected fsync failure after store rename');
                } catch (error) {
                  if (!(error instanceof Deno.errors.NotFound)) throw error;
                }
              }
              return await original(...args);
            }) as typeof Deno.open;
            return await target.promote();
          },
        ),
      Error,
      'injected fsync failure',
    );
    Deno.open = original;
    assert(injected);
    assertEquals(await Deno.readTextFile(join(dir, 'new')), 'candidate');
    assertEquals(await Deno.readTextFile(join(media, 'old')), 'prior');
    await assertRejects(
      () => openStore(config(dir)),
      Error,
      'restore promotion',
    );
    await assertRejects(
      () =>
        withRestoreTarget(config(dir), media, { replace: true }, async () => {
          assertEquals(await Deno.readTextFile(join(dir, 'old')), 'prior');
          assertEquals(await Deno.readTextFile(join(media, 'old')), 'prior');
          throw new Error('recovered pair');
        }),
      Error,
      'recovered pair',
    );
  } finally {
    Deno.open = original;
    await Deno.remove(root, { recursive: true });
  }
});
