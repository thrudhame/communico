import { assertEquals, assertRejects } from '@std/assert';
import { publish } from '#engine/store/files.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('store publication: no-replace protects occupied destinations including symlinks', async () => {
  const root = await Deno.makeTempDir({ prefix: "publish's-" });
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    await Deno.mkdir(root + '/source', { mode: 0o700 });
    await Deno.writeTextFile(root + '/source/private', 'snapshot', {
      mode: 0o600,
    });
    await Deno.mkdir(root + '/destination');
    await Deno.writeTextFile(root + '/destination/keep', 'original');
    await assertRejects(() =>
      publish(ffi, root + '/source', root + '/destination')
    );
    assertEquals(
      await Deno.readTextFile(root + '/destination/keep'),
      'original',
    );
    assertEquals(await Deno.readTextFile(root + '/source/private'), 'snapshot');
    await Deno.symlink(root + '/destination', root + '/link');
    await assertRejects(() => publish(ffi, root + '/source', root + '/link'));
    assertEquals((await Deno.lstat(root + '/link')).isSymlink, true);
    await publish(ffi, root + '/source', root + "/published's");
    assertEquals(
      await Deno.readTextFile(root + "/published's/private"),
      'snapshot',
    );
    await assertRejects(
      () => Deno.stat(root + '/source'),
      Deno.errors.NotFound,
    );
  } finally {
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store publication: EXDEV branch stages a private copy then no-replace renames', async () => {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const rename = ffi.renameNoReplace.bind(ffi);
  let calls = 0;
  ffi.renameNoReplace = (source, target) =>
    ++calls === 1 ? Promise.resolve(false) : rename(source, target);
  try {
    await Deno.mkdir(root + '/source');
    await Deno.writeTextFile(root + '/source/data', 'whole snapshot', {
      mode: 0o600,
    });
    await publish(ffi, root + '/source', root + '/destination');
    assertEquals(calls, 2);
    assertEquals(
      await Deno.readTextFile(root + '/destination/data'),
      'whole snapshot',
    );
    assertEquals(
      (await Deno.stat(root + '/destination/data')).mode! & 0o777,
      0o600,
    );
    await assertRejects(
      () => Deno.stat(root + '/source'),
      Deno.errors.NotFound,
    );
  } finally {
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('store ownership: another owner refuses before sweeping or opening the live store', async () => {
  const root = await Deno.makeTempDir();
  const options = {
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 60,
  };
  const store = await openStore(options);
  try {
    await Deno.mkdir(root + '/live/preserve.new');
    await Deno.writeTextFile(
      root + '/live/preserve.new/in-progress',
      'owner work',
    );
    await assertRejects(
      () => openStore(options),
      Error,
      'store is already owned',
    );
    assertEquals(
      await Deno.readTextFile(root + '/live/preserve.new/in-progress'),
      'owner work',
    );
    await (await store.server()).execute(
      "INSERT INTO meta VALUES('test','still writable')",
    );
  } finally {
    await store.close();
  }
  const reopened = await openStore(options);
  try {
    assertEquals(
      await (await reopened.server()).query(
        "SELECT v FROM meta WHERE k='test'",
      ),
      [{ v: 'still writable' }],
    );
  } finally {
    await reopened.close();
    await Deno.remove(root, { recursive: true });
  }
});
