import { assert } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('store snapshot: reliable intent projection, delivery and pruning retain one recoverable cut', async () => {
  const root = await Deno.makeTempDir();
  const store = await openStore({
    dir: root + '/live',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 2,
    idleseconds: 3600,
  });
  const tenant = await store.tenant('intent.test', { create: true });
  const server = await store.server();
  await tenant.exec(
    'CREATE TABLE intent(n INTEGER PRIMARY KEY,projected INTEGER)',
  );
  await server.exec(
    'CREATE TABLE queue(n INTEGER PRIMARY KEY); CREATE TABLE sent(n INTEGER PRIMARY KEY)',
  );
  let ready!: () => void;
  const started = new Promise<void>((resolve) => ready = resolve);
  let stop = false;
  const traffic = (async () => {
    for (let n = 1; !stop; n++) {
      await tenant.execute('INSERT INTO intent VALUES(?,0)', [n]);
      if (n === 2) ready();
      await server.execute('INSERT INTO queue VALUES(?)', [n]);
      await tenant.execute('UPDATE intent SET projected=1 WHERE n=?', [n]);
      await server.execute('INSERT INTO sent VALUES(?)', [n]);
      await tenant.execute('DELETE FROM intent WHERE n=?', [n]);
      await server.execute('DELETE FROM queue WHERE n=?', [n]);
      await server.execute('DELETE FROM sent WHERE n=?', [n]);
    }
  })();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    await started;
    for (let n = 0; n < 6; n++) {
      const path = root + '/cut-' + n;
      const cut = await store.snapshot(path);
      const tenantFile = cut.files.find((file) => file.kind === 'tenants')!;
      const t = await Db.open(ffi, path + '/' + tenantFile.path, 65536);
      const s = await Db.open(ffi, path + '/server/data.db', 65536);
      try {
        const intents = new Map(
          (await t.query('SELECT * FROM intent')).map((
            row,
          ) => [row.n, row.projected]),
        );
        const queue = new Set(
          (await s.query('SELECT * FROM queue')).map((row) => row.n),
        );
        const sent = new Set(
          (await s.query('SELECT * FROM sent')).map((row) => row.n),
        );
        for (const [id, projected] of intents) {
          if (projected === 1) {
            assert(
              queue.has(id),
              'projected tenant intent lost its server queue',
            );
          }
        }
        for (const id of queue) {
          assert(
            intents.has(id) || sent.has(id),
            'pruned tenant intent lost its delivery marker',
          );
        }
      } finally {
        await t.close();
        await s.close();
      }
    }
  } finally {
    stop = true;
    await traffic;
    ffi.close();
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
