// tests/store-open.test.ts — startup order: sweep, server file, hooks; the
// room/tenant face; a second open sweeps nothing and keeps the rows.
import { assert, assertEquals } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { integrityCheck } from '#engine/store/create.ts';
import { get, onStartup, type StartupStore } from '#engine/store/watermark.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

Deno.test('store open: sweep, server file, room/tenant, reopen keeps rows', async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/rooms/stale.new`, { recursive: true });
    await Deno.writeTextFile(`${dir}/rooms/stale.new/partial`, 'interrupted');
    await Deno.mkdir(`${dir}/tenants/old.new`, { recursive: true });
    const hooked: StartupStore[] = [];
    onStartup((store) => {
      hooked.push(store);
      return Promise.resolve();
    });
    const store = await openStore(config(dir));
    assertEquals(hooked.length, 1);
    await assertRejectsStat(`${dir}/rooms/stale.new`);
    await assertRejectsStat(`${dir}/tenants/old.new`);
    // The server file exists with its watermark table.
    const server = await store.server();
    await integrityCheck(server);
    assertEquals(await get(server, 'room:!a:test'), 0);
    // Room and tenant files through the pool.
    const room = await store.room('!a:test', { create: true });
    assertEquals(await room.query('SELECT value FROM id'), [{
      value: '!a:test',
    }]);
    const tenant = await store.tenant('@t:test', { create: true });
    assertEquals(await tenant.query('SELECT value FROM id'), [{
      value: '@t:test',
    }]);
    await room.exec('CREATE TABLE probe(n INTEGER)');
    await room.execute('INSERT INTO probe VALUES(1)');
    assert(store.stats().openFiles >= 2, 'pool holds the room and tenant');
    await store.close();
    // A second open: no sweep needed, rows kept, stats start empty.
    const again = await openStore(config(dir));
    assertEquals(hooked.length, 2);
    const reopened = await again.room('!a:test');
    assertEquals(await reopened.query('SELECT n FROM probe'), [{ n: 1 }]);
    assertEquals(again.stats().poolErrors, []);
    await again.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function assertRejectsStat(path: string): Promise<void> {
  let missing = false;
  try {
    await Deno.stat(path);
  } catch (error) {
    missing = error instanceof Deno.errors.NotFound;
  }
  assert(missing, `${path} must have been swept`);
}
