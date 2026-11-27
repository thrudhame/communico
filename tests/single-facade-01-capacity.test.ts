import { Journal } from '#engine/facade/journal.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { enrollLink, linkHandler } from '#engine/facade/link.ts';
import { NoticeHub } from '#engine/facade/notices.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { bindRole } from '#engine/facade/role.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import {
  EMPTY_CUT,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
  type LinkRecord,
} from '#engine/facade/protocol.ts';
import { LinkClient, startLinkTransport } from '#engine/facade/transport.ts';
import { MediaCache } from '#engine/media/cache.ts';
import { uploadMedia } from '#engine/media.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { Admission } from '#engine/store/admission.ts';
import { Capacity, type CapacityProbe } from '#engine/store/capacity.ts';
import { createDatabase } from '#engine/store/create.ts';
import { type Database, Db } from '#engine/store/db.ts';
import { StoreError, Turso } from '#engine/store/ffi.ts';
import { databaseFiles, serverDirectory } from '#engine/store/layout.ts';
import {
  StorageBusyError,
  StoragePressureError,
} from '#engine/store/pressure.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { onStartup } from '#engine/store/watermark.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { assert, assertEquals, assertRejects } from '@std/assert';
import { lstat } from 'node:fs/promises';
import { adminCall } from './admin-client.ts';
import { makeServer, seedServer } from './federation/doc-helper.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { startHttp } from './http-app.ts';
import { fedCaller } from './http-federation.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('facade capacity: local status exposes the default budget before pairing', async () => {
  const tls = await facadeTls();
  try {
    const socket = `${tls.dir}/capacity.sock`;
    const settings = `${tls.dir}/capacity.toml`;
    await Deno.mkdir(`${tls.dir}/media`);
    const store = await openStore(settingsFor(`${tls.dir}/store`), { schemas });
    let cachedBytes: number;
    try {
      const cache = new MediaCache(await store.server(), `${tls.dir}/media`);
      await cache.start();
      try {
        const row = await publish(
          cache,
          cacheId('cold-cached-thumbnail', true),
          8192,
        );
        cachedBytes = Number(
          (await lstat(cache.directory + '/' + row.blob, { bigint: true }))
            .blocks * 512n,
        );
        assert(cachedBytes > 0);
      } finally {
        await cache.close();
      }
    } finally {
      await store.close();
    }
    await Deno.writeTextFile(
      settings,
      `[server]\nname="logical.test"\nrole="facade"\nport=0\n` +
        `[store]\ndir="${tls.dir}/store"\n` +
        `[media]\nroot="${tls.dir}/media"\n` +
        `[admin]\nsocket="${socket}"\n` +
        `[federation]\nenabled=false\n` +
        `[facade]\nnodeid="edge_a"\nurl="https://127.0.0.1:0"\nlinkport=0\n` +
        `linkcert="${tls.dir}/facade.crt"\nlinkkey="${tls.dir}/facade.key"\n` +
        `linkcacerts=["${tls.dir}/ca.crt"]\n`,
    );
    const edge = await facadeProcess(
      settings,
      'facade: link/local admin ready',
      [],
      { probeScratch: `${tls.dir}/store/.scratch` },
    );
    try {
      const response = await adminCall(socket, 'facade/status');
      assertEquals(response.status, 200, JSON.stringify(response));
      assertEquals(response.body.result.initialized, false);
      const capacity = response.body.result.capacity;
      assert(capacity, 'local facade status must show storage capacity');
      assertEquals(
        capacity.coldStartReclamation,
        'after-identity-and-cache-index',
      );
      assertEquals(capacity.filesystems.length, 1);
      const [disk] = capacity.filesystems;
      assert(disk.totalBytes > 0 && disk.freeBytes >= 0);
      assertEquals(disk.budgetBytes, Math.floor(disk.totalBytes * 0.99));
      assertEquals(disk.usedBytes, disk.protectedBytes + disk.reclaimableBytes);
      assertEquals(disk.reclaimableBytes, cachedBytes);
      assertEquals(typeof disk.quotaBackstop, 'boolean');
      assertEquals(disk.filesystemFull, false);
      assertEquals(disk.checkpoint, {
        active: false,
        overshootBytes: 0,
        peakOvershootBytes: 0,
        retainedWalBytes: 0,
      });
      const scratch = async () =>
        (await adminCall(socket, 'facade/status')).body.result.capacity.scratch;
      const baseline = await scratch();
      const spill = `${tls.dir}/store/.scratch/live-spill`;
      await Deno.writeFile(spill, new Uint8Array(8192).fill(1));
      const bytes = Number(
        (await lstat(spill, { bigint: true })).blocks * 512n,
      );
      assert(bytes > 0);
      const current = await scratch();
      assertEquals(current.currentBytes, baseline.currentBytes + bytes);
      assert(current.observedPeakBytes >= current.currentBytes);
      await Deno.remove(spill);
      assertEquals(await scratch(), {
        currentBytes: baseline.currentBytes,
        observedPeakBytes: current.observedPeakBytes,
      });
    } finally {
      await edge.stop();
    }
  } finally {
    await tls.close();
  }
});

Deno.test('facade capacity review: register only verified cache before recovery writes', async (t) => {
  const tls = await facadeTls();
  const settings = settingsFor(`${tls.dir}/store`);
  const mediaRoot = `${tls.dir}/media`;
  const identity = {
    role: 'facade',
    server: 'logical.test',
    node: 'edge_a',
  } as const;
  let writeDuringStartup: (() => Promise<void>) | undefined;
  onStartup(async (opening) => {
    const db = await opening.server();
    if (writeDuringStartup && db.path.startsWith(`${settings.dir}/`)) {
      await db.execute('INSERT INTO startup_receipt VALUES (1)');
      await writeDuringStartup();
    }
  });
  try {
    const owner = new Capacity([settings.dir, mediaRoot], null);
    const store = await openStore(settings, { schemas, capacityOwner: owner });
    let blobPath: string;
    try {
      await bindRole(store, identity);
      const db = await store.server();
      await db.exec('CREATE TABLE startup_receipt (id INTEGER PRIMARY KEY)');
      const cache = new MediaCache(db, mediaRoot, undefined, owner);
      try {
        await cache.start();
        const row = await publish(cache, cacheId('startup'), MiB);
        blobPath = `${cache.directory}/${row.blob}`;
      } finally {
        await cache.close();
      }
      await db.execute(
        `INSERT INTO media_cache SELECT 'bad',origin,'bad',variant,scope,'invalid',size,content_type,filename,created_ms,accessed_ms+1 FROM media_cache`,
      );
    } finally {
      await store.close();
    }
    const configure = (budget: number, nodeid: string = identity.node) =>
      setConfigForTests({
        server: { name: identity.server, role: identity.role },
        media: { root: mediaRoot },
        facade: {
          phase: 'f0',
          nodeid,
          storagebudgetbytes: budget,
          linkcert: `${tls.dir}/facade.crt`,
          linkkey: `${tls.dir}/facade.key`,
          linkcacerts: [`${tls.dir}/ca.crt`],
        },
      });
    const usage = (await owner.status()).filesystems[0].usedBytes;
    let recovered = false;
    writeDuringStartup = () => {
      recovered = true;
      return Promise.resolve();
    };
    const start = async () => {
      const runtime = await openFacadeRuntime(settings);
      await runtime.close();
    };
    await t.step(
      'wrong durable identity leaves the cache untouched',
      async () => {
        configure(usage - MiB / 2, 'edge_b');
        const error = await assertRejects(start, LinkError);
        assertEquals(error.code, 'LINK_IDENTITY_MISMATCH');
        assertEquals(recovered, false);
        assertEquals((await Deno.stat(blobPath)).size, MiB);
      },
    );
    await t.step(
      'a malformed index never exposes a partially verified cache',
      async () => {
        configure(usage - MiB / 2);
        const register = Capacity.prototype.registerCacheBlob;
        let registered = false;
        Capacity.prototype.registerCacheBlob = function (path, blob) {
          if (path === blobPath) registered = true;
          return register.call(this, path, blob);
        };
        try {
          await assertRejects(
            start,
            Error,
            'invalid media cache blob identity',
          );
        } finally {
          Capacity.prototype.registerCacheBlob = register;
        }
        assertEquals(registered, false);
        assertEquals(recovered, false);
        assertEquals((await Deno.stat(blobPath)).size, MiB);
      },
    );
    // Repair the fixture without running its startup write. A fresh owner
    // below will account the store with the valid cache still on disk.
    const files = databaseFiles(serverDirectory(settings.dir));
    const fix = new Turso(settings.library);
    try {
      const db = await Db.open(fix, files.database, MiB);
      try {
        await db.execute("DELETE FROM media_cache WHERE cache_key='bad'");
      } finally {
        await db.close();
      }
    } finally {
      fix.close();
    }
    await t.step(
      'unreservable open reports retryable pressure without cache deletion',
      async () => {
        // Force the native open to need an inode, without discarding any WAL
        // records. Restore the fixture for the clean-reopen case below.
        assertEquals((await Deno.stat(files.wal)).size, 0);
        await Deno.rename(files.wal, `${tls.dir}/saved-wal`);
        try {
          configure(usage - MiB / 2);
          await assertRejects(
            start,
            StoragePressureError,
            'Facade startup blocked by storage pressure',
          );
          await assertRejects(() => Deno.stat(files.wal), Deno.errors.NotFound);
          assertEquals(recovered, false);
          assertEquals((await Deno.stat(blobPath)).size, MiB);
        } finally {
          await Deno.rename(`${tls.dir}/saved-wal`, files.wal);
        }
      },
    );
    await t.step(
      'a clean store can reclaim indexed cache for startup work',
      async () => {
        configure(usage - MiB / 2);
        await start();
        assertEquals(recovered, true);
        await assertRejects(() => Deno.stat(blobPath), Deno.errors.NotFound);
      },
    );
  } finally {
    writeDuringStartup = undefined;
    setConfigForTests({});
    await tls.close();
  }
});

Deno.test('facade capacity review: sweep private staging before reserving scratch', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-sweep-scratch-' });
  const settings = settingsFor(`${root}/store`);
  const stage = `${settings.dir}/rooms/abandoned.new`;
  await Deno.mkdir(stage, { recursive: true });
  await Deno.writeTextFile(`${stage}/payload`, 'unpublished');
  const capacityOwner = new Capacity([settings.dir], null, async () => {
    const occupied = await Deno.stat(stage).then(() => true, (error) => {
      if (error instanceof Deno.errors.NotFound) return false;
      throw error;
    });
    return {
      totalBytes: 64 * MiB,
      freeBytes: occupied ? 0 : 64 * MiB,
      freeInodes: occupied ? 0 : 100,
      blockSize: 4096,
      device: 'test',
    };
  });
  let store: Store | undefined;
  try {
    store = await openStore(settings, { schemas, capacityOwner });
    assertEquals(Deno.env.get('TMPDIR'), `${settings.dir}/.scratch`);
    assert((await Deno.stat(`${settings.dir}/.scratch`)).isDirectory);
    await assertRejects(() => Deno.stat(stage), Deno.errors.NotFound);
  } finally {
    await store?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: incremental admission never walks managed roots', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-ledger-' });
  const capacity = new Capacity([root], 2 ** 20);
  const readDir = Deno.readDir;
  let walks = 0;
  try {
    await Deno.writeFile(root + '/retained', new Uint8Array(8192));
    await capacity.status();
    Deno.readDir = (path) => {
      walks++;
      return readDir(path);
    };
    for (let i = 0; i < 4; i++) {
      const path = root + '/staged-' + i;
      const lease = await capacity.reserveStaging(path, 8192);
      try {
        await Deno.writeFile(path, new Uint8Array(8192));
      } finally {
        lease.release();
      }
    }
    assertEquals(walks, 0);
  } finally {
    Deno.readDir = readDir;
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: incremental usage matches a fresh inventory after mixed writes', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-ledger-drift-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const capacity = new Capacity([root], 64 * 2 ** 20);
  let db: Db | undefined;
  try {
    const preload = root + '/preload';
    await Deno.writeFile(preload, new Uint8Array(4096).fill(1));
    await Deno.link(preload, preload + '-link');
    await capacity.initialize();
    const old = await createDatabase(ffi, root, 'old', {
      capacity,
      checkpointlogbytes: 2 ** 20,
      schema: (db) => db.exec('CREATE TABLE data (payload BLOB)'),
      verify: () => Promise.resolve(),
    });
    const path = await createDatabase(ffi, root, 'retained', {
      capacity,
      checkpointlogbytes: 2 ** 20,
      schema: (db) => db.exec('CREATE TABLE data (payload BLOB)'),
      verify: () => Promise.resolve(),
    });
    db = await Db.open(ffi, path + '/data.db', 2 ** 20, undefined, capacity);
    await db.execute('INSERT INTO data VALUES (?)', [
      new Uint8Array(145000).fill(8),
    ]);
    await assertRejects(
      () =>
        db!.tx(async (tx) => {
          await tx.execute('INSERT INTO data VALUES (?)', [
            new Uint8Array(80000).fill(9),
          ]);
          throw new Error('forced rollback');
        }),
      Error,
      'forced rollback',
    );
    await capacity.remove(old, { recursive: true });
    await capacity.remove(preload);
    await capacity.ensureDirectory(root + '/media/subdir');
    const part = root + '/media/subdir/blob.part';
    const final = root + '/media/subdir/blob';
    const lease = await capacity.reserveStaging(part, 64 * 1024);
    try {
      lease.track(final);
      await Deno.writeFile(part, new Uint8Array(28000).fill(1));
      await Deno.rename(part, final);
    } finally {
      lease.release();
    }
    const accounted = capacity.accountedBytes();
    const fresh = await new Capacity([root]).status();
    assertEquals(accounted, fresh.filesystems[0].usedBytes);
    assertEquals(await db.query('SELECT length(payload) AS size FROM data'), [{
      size: 145000,
    }]);
  } finally {
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: incremental grants continue during a status walk', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-ledger-scan-' });
  const capacity = new Capacity([root], 2 ** 20);
  const blocked = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const readDir = Deno.readDir;
  let status: ReturnType<Capacity['status']> | undefined;
  let grant: ReturnType<Capacity['reserveStaging']> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await capacity.initialize();
    Deno.readDir = async function* (path) {
      if (path === root) {
        blocked.resolve();
        await resume.promise;
      }
      yield* readDir(path);
    };
    status = capacity.status();
    await blocked.promise;
    await Deno.writeFile(root + '/external', new Uint8Array(4096).fill(1));
    const owned = root + '/owned';
    grant = capacity.reserveStaging(owned, 8192);
    const lease = await Promise.race([
      grant,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('grant blocked by inventory')),
          1000,
        );
      }),
    ]);
    try {
      await Deno.writeFile(owned, new Uint8Array(8192).fill(1));
    } finally {
      lease.release();
    }
    resume.resolve();
    const fresh = await status;
    assertEquals(capacity.accountedBytes(), fresh.filesystems[0].usedBytes);
  } finally {
    clearTimeout(timer);
    Deno.readDir = readDir;
    resume.resolve();
    await (await grant?.catch(() => undefined))?.release();
    await status?.catch(() => undefined);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity review: moving the last alias preserves its inode charge', async () => {
  const root = await Deno.makeTempDir();
  try {
    const from = `${root}/from`;
    const to = `${root}/to`;
    const known = `${root}/known`;
    await Deno.mkdir(from);
    await Deno.writeFile(known, new Uint8Array(4096).fill(1));
    await Deno.link(known, `${from}/alias`);
    const capacity = new Capacity([root]);
    await capacity.initialize();
    await Deno.writeFile(known, new Uint8Array(65536).fill(2));
    capacity.refresh(known);
    await capacity.remove(known);
    await Deno.rename(from, to);
    capacity.moved(from, to);
    assertEquals(
      capacity.accountedBytes(),
      (await new Capacity([root]).status()).filesystems[0].usedBytes,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity review: status accounts for a live staging file only through its grant', async () => {
  const root = await Deno.makeTempDir();
  try {
    const capacity = new Capacity([root]);
    const path = `${root}/stage`;
    const lease = await capacity.reserveStaging(path, 64 * 1024);
    const before = capacity.accountedBytes();
    try {
      await Deno.writeFile(path, new Uint8Array(64 * 1024).fill(1));
      const [disk] = (await capacity.status()).filesystems;
      assertEquals(disk.usedBytes, before);
      assertEquals(disk.protectedBytes, before);
      assertEquals(disk.reclaimableBytes, 0);
      assert(disk.reservedBytes >= 64 * 1024);
    } finally {
      lease.release();
    }
    const [committed] = (await capacity.status()).filesystems;
    assertEquals(committed.reservedBytes, 0);
    assert(committed.usedBytes >= before + 64 * 1024);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity review: observing scratch does not leave an admission charge', async () => {
  const root = await Deno.makeTempDir();
  try {
    const scratch = `${root}/.scratch`;
    await Deno.mkdir(scratch);
    const before =
      (await new Capacity([root]).status()).filesystems[0].usedBytes;
    const capacity = new Capacity([root], before + 64 * 1024);
    capacity.setScratchRoot(scratch);
    const spill = `${scratch}/spill`;
    await Deno.writeFile(spill, new Uint8Array(128 * 1024).fill(1));
    const observed = await capacity.status();
    assert(observed.scratch.currentBytes >= 128 * 1024);
    assertEquals(
      observed.scratch.observedPeakBytes,
      observed.scratch.currentBytes,
    );
    assertEquals(
      observed.filesystems[0].protectedBytes,
      before + observed.scratch.currentBytes,
    );
    await Deno.remove(spill);
    (await capacity.reserveStaging(`${root}/stage`, 4096)).release();
    const clean = await capacity.status();
    assertEquals(clean.scratch.currentBytes, 0);
    assertEquals(
      clean.scratch.observedPeakBytes,
      observed.scratch.currentBytes,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity review: materialized staging makes a recoverable physical shortfall busy', async () => {
  const root = await Deno.makeTempDir();
  try {
    let freeBytes = 163840;
    let freeInodes = 1;
    const capacity = new Capacity([root], null, () => ({
      totalBytes: MiB,
      freeBytes,
      freeInodes,
      device: 1,
      blockSize: 4096,
    }));
    const path = `${root}/stage`;
    const lease = await capacity.reserveStaging(path, 128 * 1024);
    try {
      await Deno.writeFile(path, new Uint8Array(128 * 1024).fill(1));
      freeBytes -= 128 * 1024;
      freeInodes--;
      await assertRejects(
        () =>
          new Admission().run(() =>
            capacity.reserveStaging(`${root}/next`, 4096)
          ),
        StorageBusyError,
      );
      const impossible = await assertRejects(
        () =>
          new Admission().run(() =>
            capacity.reserveStaging(`${root}/too-big`, MiB)
          ),
        StoragePressureError,
      );
      assert(!(impossible instanceof StorageBusyError));
    } finally {
      await Deno.remove(path);
      freeBytes += 128 * 1024;
      freeInodes++;
      lease.release();
    }
    (await capacity.reserveStaging(`${root}/next`, 4096)).release();
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity review: re-probe when a physical sample straddles settlement', async () => {
  const root = await Deno.makeTempDir();
  try {
    for (const materializes of [false, true]) {
      const observing = Promise.withResolvers<void>();
      const resume = Promise.withResolvers<void>();
      const path = `${root}/stage`;
      const target = `${root}/next`;
      let freeBytes = 128 * 1024;
      let samples = 0;
      const capacity = new Capacity([root], null, async (candidate) => {
        const observed = freeBytes;
        if (candidate === target && ++samples === 1) {
          observing.resolve();
          await resume.promise;
        }
        return {
          totalBytes: MiB,
          freeBytes: observed,
          freeInodes: 10,
          device: 1,
          blockSize: 4096,
        };
      });
      const holder = await capacity.reserveStaging(path, 96 * 1024);
      const next = new Admission().run(() =>
        capacity.reserveStaging(target, 4096)
      );
      void next.catch(() => {});
      try {
        await observing.promise;
        if (materializes) {
          await Deno.writeFile(path, new Uint8Array(96 * 1024).fill(1));
          freeBytes -= 96 * 1024;
        }
        holder.release();
        resume.resolve();
        if (materializes) {
          const error = await assertRejects(() => next, StoragePressureError);
          assert(!(error instanceof StorageBusyError));
        } else (await next).release();
        assertEquals(samples, 2);
      } finally {
        holder.release();
        resume.resolve();
        (await next.catch(() => undefined))?.release();
      }
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity review: large publication path sets settle without unbounded arguments', async () => {
  const root = await Deno.makeTempDir();
  try {
    const path = `${root}/published`;
    const capacity = new Capacity([root]);
    const lease = await capacity.reservePublication(path, 1, [4096]);
    try {
      // Paths already cleaned after an EXDEV copy do not need a disk fixture.
      for (let i = 0; i < 140_000; i++) lease.track(`${root}/gone-${i}`);
      await Deno.writeFile(path, new Uint8Array(4096).fill(1));
    } finally {
      lease.release();
    }
    const accounted = capacity.accountedBytes();
    const [disk] = (await capacity.status()).filesystems;
    assertEquals(disk.reservedBytes, 0);
    assertEquals(accounted, disk.usedBytes);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: scratch peak samples checkpoints and status, not statements', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-observed-scratch-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const capacity = new Capacity([root]);
  let db: Db | undefined;
  try {
    const scratch = `${root}/.scratch`;
    await Deno.mkdir(scratch);
    capacity.setScratchRoot(scratch);
    db = await Db.open(ffi, root + '/data.db', 65536, undefined, capacity);
    await db.exec('CREATE TABLE receipt(body BLOB)');
    const spill = `${scratch}/live-spill`;
    await Deno.writeFile(spill, new Uint8Array(8192).fill(1));
    const bytes = Number((await lstat(spill, { bigint: true })).blocks * 512n);
    assert(bytes > 0);
    const before = db.gate.stats().completed;
    assertEquals(await db.query('SELECT 1 AS id'), [{ id: 1 }]);
    await Deno.remove(spill);
    assertEquals(db.gate.stats().completed, before);
    assertEquals((await capacity.status()).scratch, {
      currentBytes: 0,
      observedPeakBytes: 0,
    });

    await Deno.writeFile(spill, new Uint8Array(8192).fill(1));
    await db.execute('INSERT INTO receipt VALUES (?)', [new Uint8Array(98304)]);
    assertEquals(db.gate.stats().completed, before + 1);
    await Deno.remove(spill);
    assertEquals((await capacity.status()).scratch, {
      currentBytes: 0,
      observedPeakBytes: bytes,
    });
  } finally {
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: native ENOSPC does not advance a link cut or lose a prior ACK', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-capacity-journal-' });
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const caps = [{ type: 'control', version: 1 }];
  const stream = { source: 'home', incarnation: 'home-1', stream: 'control' };
  const cut = ({ sequence, hash }: LinkRecord) => ({ sequence, hash });
  const open = () => openStore(settings, { schemas: { server: serverSchema } });
  let store: Store | undefined;
  try {
    store = await open();
    let journal = new Journal(await store.server(), caps);
    const append = (operationId: string) =>
      journal.append('edge', {
        ...stream,
        type: 'control',
        version: 1,
        operationId,
        payload: { roster: [] },
      });
    const one = await append('previous');
    const two = await append('next');
    await journal.receive('home', [one]);
    await journal.complete('home', stream, cut(one), { accepted: true });

    const commit = Turso.prototype.commit;
    let injected = false;
    let refusal: unknown;
    Turso.prototype.commit = function (connection) {
      if (injected) return commit.call(this, connection);
      injected = true;
      // A native storage failure after the journal has staged the attempted
      // record but before commit can acknowledge it.
      return Promise.reject(
        new StoreError(13, 'database or disk is full', 'DatabaseFull'),
      );
    };
    try {
      refusal = await assertRejects(() => journal.receive('home', [two]));
    } finally {
      Turso.prototype.commit = commit;
    }
    assert(injected, 'the fault must reach native commit admission');
    await store.close();
    store = undefined;
    store = await open();
    journal = new Journal(await store.server(), caps);
    const retained = await journal.heads('home', 'in', stream);
    assertEquals(retained.received, cut(one));
    assertEquals(retained.applied, cut(one));
    const received = await journal.receive('home', [two]);
    assertEquals(received?.received, cut(two));
    assertEquals(received?.applied, cut(one));
    assertEquals(await journal.receive('home', [two]), received);
    assertEquals(
      (await journal.heads('fresh', 'in', stream)).received,
      EMPTY_CUT,
    );
    assert(refusal instanceof Error);
    assertEquals(
      refusal.name,
      'StoragePressureError',
      'link admission must surface typed storage pressure',
    );
  } finally {
    await store?.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('facade capacity: file exhaustion with the software cap unset leaves no partial publication and can retry', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-capacity-file-' });
  let store: Store | undefined;
  let cache: MediaCache | undefined;
  try {
    const settings = settingsFor(root + '/store');
    const mediaRoot = root + '/media';
    const capacityOwner = new Capacity([settings.dir, mediaRoot], null);
    store = await openStore(settings, {
      schemas: { server: serverSchema },
      capacityOwner,
    });
    cache = new MediaCache(await store.server(), mediaRoot, 32, capacityOwner);
    const media = cache;
    await media.start();
    const identity = (mediaId: string) => ({
      origin: 'remote.test',
      mediaId,
      variant: 'original',
      scope: 'remote' as const,
    });
    const publish = (id: string) =>
      media.fetch(
        identity(id),
        1,
        async (output) => {
          const writer = output.getWriter();
          await writer.write(new Uint8Array([1, 2, 3, 4]));
          await writer.close();
          return {
            contentType: 'application/octet-stream',
            filename: null,
            size: 4,
          };
        },
        undefined,
        4,
      );
    const old = await publish('previous');
    const open = Deno.open;
    const sync = Deno.FsFile.prototype.sync;
    const staging = new WeakSet<Deno.FsFile>();
    let injected = false;
    let refusal: unknown;
    Deno.open = async function (path, options) {
      const file = await open(path, options);
      if (
        typeof path === 'string' && path.startsWith(media.directory + '/') &&
        path.endsWith('.part')
      ) {
        staging.add(file);
      }
      return file;
    };
    Deno.FsFile.prototype.sync = function () {
      if (!staging.has(this)) return sync.call(this);
      injected = true;
      return Promise.reject(
        Object.assign(new Error('No space left on device'), { code: 'ENOSPC' }),
      );
    };
    try {
      refusal = await assertRejects(() => publish('next'));
    } finally {
      Deno.open = open;
      Deno.FsFile.prototype.sync = sync;
    }
    assert(injected, 'fault must happen during fsync of the staged object');
    assertEquals(await media.get(identity('next')), null);
    const entries: string[] = [];
    for await (const entry of Deno.readDir(media.directory)) {
      entries.push(entry.name);
    }
    assertEquals(entries, [old.blob]);
    const retry = await publish('next');
    assertEquals(await media.get(identity('next')), retry);
    assertEquals(
      await Deno.readFile(`${media.directory}/${old.blob}`),
      new Uint8Array([1, 2, 3, 4]),
    );
    assert(refusal instanceof Error);
    assertEquals(
      refusal.name,
      'StoragePressureError',
      'file owner must surface typed storage pressure',
    );
  } finally {
    await cache?.close();
    await store?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: staged media and native journal writers cannot oversubscribe one explicit budget', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-capacity-race-' });
  const mediaRoot = root + '/media';
  const MiB = 1024 * 1024;
  const budgetBytes = 12 * MiB;
  const size = 8 * MiB;
  const staged = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<true>();
  let observeNative = false;
  class ObservedCapacity extends Capacity {
    override async tryReserveNative(
      path: string,
      creates: number,
      bytes: number,
    ) {
      try {
        return await super.tryReserveNative(path, creates, bytes);
      } finally {
        if (observeNative) admitted.resolve(true);
      }
    }
  }
  let store: Store | undefined;
  let cache: MediaCache | undefined;
  try {
    const capacityOwner = new ObservedCapacity(
      [root + '/store', mediaRoot],
      budgetBytes,
    );
    const settings = {
      dir: root + '/store',
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 8 * MiB,
      maxopenfiles: 8,
      idleseconds: 300,
    };
    const open = () =>
      openStore(settings, { schemas: { server: serverSchema }, capacityOwner });
    store = await open();
    const db = await store.server();
    cache = new MediaCache(db, mediaRoot, 32, capacityOwner);
    await cache.start();
    const caps = [{ type: 'control', version: 1 }];
    const journal = new Journal(db, caps);
    const source = { source: 'edge', incarnation: 'edge-1', stream: 'control' };
    const identity = {
      origin: 'remote.test',
      mediaId: 'first',
      variant: 'original',
      scope: 'remote' as const,
    };
    const mediaWork = cache.fetch(
      identity,
      1,
      async (output) => {
        const writer = output.getWriter();
        await writer.write(new Uint8Array(size).fill(37));
        await writer.close();
        staged.resolve();
        await release.promise;
        return {
          contentType: 'application/octet-stream',
          filename: null,
          size,
        };
      },
      undefined,
      size,
    );
    let native!: PromiseSettledResult<LinkRecord>;
    let media!: PromiseSettledResult<Awaited<typeof mediaWork>>;
    let outcome: Promise<PromiseSettledResult<LinkRecord>[]> | undefined;
    try {
      // The staging file is already allocated but not published; the native
      // transaction will need its own DB/log blocks before its ACK.
      await Promise.race([staged.promise, mediaWork]);
      observeNative = true;
      outcome = Promise.allSettled([
        journal.append('home', {
          ...source,
          type: 'control',
          version: 1,
          operationId: 'over-budget-together',
          payload: { data: 'x'.repeat(size) },
        }),
      ]);
      assert(
        await Promise.race([admitted.promise, outcome.then(() => false)]),
        'native admission must see the live staging grant',
      );
      observeNative = false;
      release.resolve();
      [native] = await outcome;
    } finally {
      observeNative = false;
      release.resolve();
      [media] = await Promise.allSettled([mediaWork]);
      await outcome;
    }
    assert(
      native.status === 'rejected' || media.status === 'rejected',
      'native plus staged accepted payload exceeds the total facade budget',
    );
    assertEquals(
      media.status,
      'fulfilled',
      'already reserved staging can finish',
    );
    assert(
      native.status === 'rejected' &&
        native.reason instanceof StoragePressureError,
    );
    assertEquals(
      (await journal.heads('home', 'out', source)).applied,
      EMPTY_CUT,
    );
    assertEquals((await cache.get(identity))?.size, size);
    await cache.close();
    cache = undefined;
    await store.close();
    store = await open();
    const reopened = await store.server();
    const recovered = new Journal(reopened, caps);
    assertEquals(
      (await recovered.heads('home', 'out', source)).applied,
      EMPTY_CUT,
    );
    await recovered.append('home', {
      ...source,
      type: 'control',
      version: 1,
      operationId: 'over-budget-together',
      payload: { data: 'fits after rollback' },
    });
    assertEquals(
      (await recovered.heads('home', 'out', source)).received.sequence,
      1,
    );
    cache = new MediaCache(reopened, mediaRoot, 32, capacityOwner);
    await cache.start({ inventoryOnly: true });
    assertEquals((await cache.get(identity))?.size, size);
  } finally {
    await cache?.close();
    await store?.close();
    await Deno.remove(root, { recursive: true });
  }
});

const MiB = 1024 * 1024;

Deno.test('facade capacity: private database creation is bounded before publication', async () => {
  const root = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  try {
    const options = {
      checkpointlogbytes: 65536,
      capacity: new Capacity([root], 256 * 1024),
      schema: async (db: Database) => {
        await db.exec('CREATE TABLE payload(value BLOB)');
        await db.exec('INSERT INTO payload VALUES(zeroblob(524288))');
      },
      verify: () => Promise.resolve(),
    };
    await assertRejects(
      () => createDatabase(ffi, root, 'server', options),
      StoragePressureError,
    );
    assertEquals(await Array.fromAsync(Deno.readDir(root)), []);
    const [disk] = (await options.capacity.status()).filesystems;
    assertEquals(disk.reservedBytes, 0);
    const path = await createDatabase(ffi, root, 'server', {
      ...options,
      schema: (db) => db.exec('CREATE TABLE payload(value BLOB)'),
    });
    const db = await Db.open(
      ffi,
      path + '/data.db',
      65536,
      undefined,
      options.capacity,
    );
    try {
      assertEquals(await db.query('SELECT count(*) AS count FROM payload'), [{
        count: 0,
      }]);
    } finally {
      await db.close();
    }
  } finally {
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: native bootstrap obeys its grant before writing', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-native-open-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const path = root + '/data.db';
  const blockSize = 4096;
  let db: Db | undefined;
  let freeBytes = 15 * blockSize;
  const capacity = new Capacity([root], null, () => ({
    device: 'bootstrap',
    totalBytes: MiB,
    freeBytes,
    freeInodes: 1000,
    blockSize,
  }));
  try {
    // An otherwise ample filesystem, but none of this grant can be used for
    // file data. The native initializer must not write its database header.
    await assertRejects(async () => {
      db = await Db.open(ffi, path, MiB, undefined, capacity);
    }, StoragePressureError);
    assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
    const file = await Deno.stat(path).catch((error) => {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    });
    assertEquals(file?.size ?? 0, 0);

    freeBytes = MiB;
    db = await Db.open(ffi, path, MiB, undefined, capacity);
    await db.exec('CREATE TABLE receipt(id INT)');
    await db.execute('INSERT INTO receipt VALUES (42)');
    await db.close();
    db = await Db.open(ffi, path, MiB, undefined, capacity);
    assertEquals(await db.query('SELECT id FROM receipt'), [{ id: 42 }]);
  } finally {
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: native open without a metadata grant cannot create its database', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-native-metadata-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const path = root + '/data.db';
  let file: number | undefined;
  try {
    const error = await assertRejects(async () => {
      file = await ffi.open(path, {
        blockSize: 4096,
        bytes: 32 * MiB,
        creates: 0,
      });
    }, StoreError);
    assert(error.storageFull, error.message);
    assertEquals(
      (await Array.fromAsync(Deno.readDir(root))).map((entry) => entry.name),
      [],
      'native file created without metadata reservation',
    );
  } finally {
    if (file !== undefined) await ffi.closeFile(file);
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: a paused snapshot refuses contention and retries after release', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-native-snapshot-' });
  const source = root + '/server';
  const target = root + '/out/data.db';
  const ffi = new Turso('./.native/libturso_ffi.so');
  const budget = 32 * MiB;
  const capacity = new Capacity([root], budget);
  let db: Db | undefined;
  let copy: Db | undefined;
  try {
    await Deno.mkdir(source);
    await Deno.mkdir(root + '/out');
    db = await Db.open(ffi, source + '/data.db', MiB, undefined, capacity);
    await db.exec('CREATE TABLE receipt(id INTEGER PRIMARY KEY, body TEXT)');
    await db.execute('INSERT INTO receipt VALUES (42, ?)', ['x'.repeat(65536)]);
    const used = (await capacity.status()).filesystems[0].usedBytes;
    const claim = await capacity.reserveStaging(
      root + '/held.part',
      budget - used - 32768,
    );
    try {
      await assertRejects(
        () => new Admission().exclusive(() => db!.vacuumInto(target)),
        StorageBusyError,
      );
      assertEquals(
        (await Array.fromAsync(Deno.readDir(root))).map((e) => e.name).sort(),
        ['out', 'server'],
      );
      await assertRejects(() => Deno.stat(target), Deno.errors.NotFound);
    } finally {
      claim.release();
    }
    await db.vacuumInto(target);
    assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
    await db.close();
    copy = await Db.open(ffi, target, MiB);
    assertEquals(
      await copy.query('SELECT id,length(body) AS bytes FROM receipt'),
      [{ id: 42, bytes: 65536 }],
    );
  } finally {
    await copy?.close();
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: contending writers cannot borrow the live grant, but readers still work', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-native-contenders-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const budget = 32 * MiB;
  const capacity = new Capacity([root], budget);
  const ready = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let db: Db | undefined;
  let first: Promise<unknown> | undefined;
  let hold: { release(): void } | undefined;
  try {
    db = await Db.open(ffi, root + '/data.db', MiB, undefined, capacity);
    await db.exec('CREATE TABLE receipt(id INTEGER PRIMARY KEY)');
    const used = (await capacity.status()).filesystems[0].usedBytes;
    // The staging grant leaves room for one native writer, not two.
    hold = await capacity.reserveStaging(
      root + '/held.part',
      budget - used - 96 * 1024,
    );
    first = db.tx(async (conn) => {
      await conn.execute('INSERT INTO receipt VALUES (1)');
      await assertRejects(
        () => db!.execute('INSERT INTO receipt VALUES (3)'),
        StorageBusyError,
      );
      ready.resolve();
      await finish.promise;
    });
    await Promise.race([ready.promise, first]);
    const second = db.execute('INSERT INTO receipt VALUES (2)');
    const observed = Promise.allSettled([second]);
    assertEquals(await db.query('SELECT * FROM receipt'), []);
    finish.resolve();
    await first;
    hold.release();
    assertEquals((await observed)[0].status, 'fulfilled');
    assertEquals(await db.query('SELECT * FROM receipt ORDER BY id'), [{
      id: 1,
    }, { id: 2 }]);
  } finally {
    finish.resolve();
    await first?.catch(() => undefined);
    hold?.release();
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: reads do not wait behind a pool of queued writers', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-queued-writers-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const path = root + '/data.db';
  const budget = 32 * MiB;
  const capacity = new Capacity([root], budget);
  let db: Db | undefined;
  try {
    db = await Db.open(ffi, path, MiB, undefined, capacity);
    await db.exec('CREATE TABLE receipt(id INTEGER PRIMARY KEY)');
    const used = (await capacity.status()).filesystems[0].usedBytes;
    const hold = await capacity.reserveStaging(
      root + '/held.part',
      budget - used - 32768,
    );
    const started = Array.from(
      { length: 8 },
      () => Promise.withResolvers<void>(),
    );
    const writes = Promise.allSettled(
      started.map((ready, id) =>
        db!.tx(async (conn) => {
          ready.resolve();
          await conn.execute('INSERT INTO receipt VALUES (?)', [id]);
        })
      ),
    );
    let observed: Promise<PromiseSettledResult<unknown>[]> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = (message: string) =>
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 1000);
      });
    try {
      await Promise.race([
        Promise.all(started.map((ready) => ready.promise)),
        watchdog('writers did not enter their callbacks'),
      ]);
      clearTimeout(timer);
      const query = db.query('SELECT * FROM receipt');
      observed = Promise.allSettled([query]);
      assertEquals(
        await Promise.race([
          query,
          watchdog('read blocked by queued writers'),
        ]),
        [],
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      hold.release();
      await writes;
      await observed;
    }
    assert((await writes).every((result) => result.status === 'fulfilled'));
    assertEquals(await db.query('SELECT COUNT(*) AS count FROM receipt'), [{
      count: 8,
    }]);
  } finally {
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: same-file writers do not queue with ample budget', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-native-parallel-' });
  const path = root + '/data.db';
  const ffi = new Turso('./.native/libturso_ffi.so');
  const queued = Promise.withResolvers<string>();
  class ObservedCapacity extends Capacity {
    override async tryReserveNative(
      path: string,
      creates: number,
      bytes: number,
    ) {
      try {
        return await super.tryReserveNative(path, creates, bytes);
      } catch (error) {
        if (error instanceof StorageBusyError) {
          const { usedBytes, freeBytes, reservedBytes, budgetBytes } =
            (await this.status()).filesystems[0];
          queued.resolve(
            `queued: used=${usedBytes} free=${freeBytes} reserved=${reservedBytes} budget=${budgetBytes}`,
          );
        }
        throw error;
      }
    }
  }
  const capacity = new ObservedCapacity([root], 48 * MiB);
  const finish = Promise.withResolvers<void>();
  const entered = Array.from(
    { length: 4 },
    () => Promise.withResolvers<void>(),
  );
  let db: Db | undefined;
  let writes: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    db = await Db.open(ffi, path, MiB, undefined, capacity);
    const managedGrouping = await db.query('PRAGMA mvcc_group_commit');
    // Separate tables avoid write/write conflicts inside the storage engine.
    for (const id of entered.keys()) {
      await db.exec(`CREATE TABLE receipt${id}(id INTEGER PRIMARY KEY)`);
    }
    const write = (id: number) =>
      db!.tx(async (conn) => {
        await conn.execute(`INSERT INTO receipt${id} VALUES (${id})`);
        entered[id].resolve();
        await finish.promise;
      });
    const first = write(0);
    writes = Promise.allSettled([first]);
    await Promise.race([entered[0].promise, first]);
    const rest = entered.slice(1).map((_, index) => write(index + 1));
    writes = Promise.allSettled([first, ...rest]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      assertEquals(
        await Promise.race([
          Promise.all(entered.map((writer) => writer.promise)).then(() =>
            'all admitted'
          ),
          queued.promise,
          new Promise((resolve) => {
            timer = setTimeout(() => resolve('writers did not enter'), 5000);
          }),
        ]),
        'all admitted',
      );
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      finish.resolve();
    }
    const results = await writes;
    await db.close();
    db = await Db.open(ffi, path, MiB);
    assertEquals(
      Object.values((await db.query('PRAGMA mvcc_group_commit'))[0]),
      [1],
    );
    for (const id of entered.keys()) {
      assertEquals(
        await db.query(`SELECT id FROM receipt${id}`),
        results[id].status === 'fulfilled' ? [{ id }] : [],
        `writer ${id}: reported result and cold durable contents must agree`,
      );
      const result = results[id];
      if (result.status === 'rejected') throw result.reason;
    }
    assertEquals(Object.values(managedGrouping[0]), [0]);
  } finally {
    finish.resolve();
    await writes;
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: a computed write replays on measured native shortfall without losing data', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-native-grow-' });
  const path = root + '/data.db';
  const ffi = new Turso('./.native/libturso_ffi.so');
  const capacity = new Capacity([root], 16 * MiB);
  let db: Db | undefined;
  try {
    db = await Db.open(ffi, path, MiB, undefined, capacity);
    await db.exec('CREATE TABLE receipt(id INTEGER PRIMARY KEY, body BLOB)');
    await db.execute('INSERT INTO receipt VALUES (1, ?) ', ['ack']);
    let attempts = 0;
    await db.tx(async (conn) => {
      attempts++;
      await conn.execute('INSERT INTO receipt VALUES (2, zeroblob(524288))');
    });
    assert(attempts > 1, 'computed bytes must exceed the initial SQL estimate');
    await assertRejects(
      () => db!.execute('INSERT INTO receipt VALUES (3, zeroblob(10485760))'),
      StoragePressureError,
    );
    assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
    await db.close();
    db = await Db.open(ffi, path, MiB, undefined, capacity);
    assertEquals(
      await db.query(
        'SELECT id, length(body) AS size FROM receipt ORDER BY id',
      ),
      [
        { id: 1, size: 3 },
        { id: 2, size: 524288 },
      ],
    );
  } finally {
    await db?.close();
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

const settingsFor = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
const schemas = {
  server: serverSchema,
  tenant: tenantSchema,
  room: roomSchema,
};

Deno.test('facade capacity: cold room creation waits for a genuinely competing grant', async () => {
  const root = await Deno.makeTempDir({ prefix: 'facade-room-contend-' });
  const ffi = new Turso('./.native/libturso_ffi.so');
  const budget = 16 * MiB;
  const capacity = new Capacity([root], budget);
  try {
    const used = (await capacity.status()).filesystems[0].usedBytes;
    const writer = await capacity.reserveNative(
      root + '/data.db',
      0,
      budget - used - 4096,
      false,
    );
    const creating = createDatabase(ffi, root, 'room', {
      capacity,
      checkpointlogbytes: MiB,
      schema: (room) => room.exec('CREATE TABLE receipt(id INT)'),
      verify: async (room) =>
        assertEquals(await room.query('SELECT * FROM receipt'), []),
    });
    let state;
    try {
      state = await Promise.race([
        creating.then(() => 'published', (error: Error) => error.name),
        new Promise((resolve) => setTimeout(() => resolve('waiting'), 80)),
      ]);
    } finally {
      writer.release();
    }
    assertEquals(
      state,
      'waiting',
      'room staging must wait for the other writer',
    );
    assertEquals(await creating, root + '/room');
    assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
  } finally {
    ffi.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: outstanding claims fence concurrent staging and checkpoints', async () => {
  const root = await Deno.makeTempDir({ prefix: 'capacity-claims-' });
  const store = root + '/store';
  const media = root + '/media';
  try {
    await Deno.mkdir(store);
    await Deno.mkdir(media);
    const path = store + '/data.db';
    await Deno.writeFile(path, Uint8Array.of(1));
    const capacity = new Capacity([store, media], 3 * MiB, (path) => ({
      totalBytes: 32 * MiB,
      freeBytes: 32 * MiB,
      freeInodes: 1000,
      blockSize: 4096,
      device: path.startsWith(store) ? 1 : 2,
    }));
    const first = await capacity.reserveStaging(media + '/first.part', 2 * MiB);
    const order: number[] = [];
    const second = capacity.reserveStaging(store + '/second.part', 2 * MiB)
      .then((lease) => {
        order.push(2);
        return lease;
      });
    const third = capacity.reserveStaging(media + '/third.part', 2 * MiB)
      .then((lease) => {
        order.push(3);
        return lease;
      });
    try {
      // Queue both oversized requests before releasing the holder. This
      // small independent claim fits and must not wait behind either one.
      const small = await capacity.reserveStaging(store + '/small.part', 4096);
      small.release();
      assertEquals(await capacity.tryCheckpoint(path), undefined);
      assertEquals(
        (await capacity.status()).filesystems[1].reservedBytes,
        2 * MiB + 32768,
      );
    } finally {
      first.release();
    }
    (await second).release();
    (await third).release();
    assertEquals(order, [2, 3]);
    const checkpoint = await capacity.tryCheckpoint(path);
    assert(checkpoint);
    try {
      await assertRejects(
        () =>
          new Admission().run(() =>
            capacity.reserveStaging(media + '/fourth.part', 2 * MiB)
          ),
        StorageBusyError,
      );
    } finally {
      checkpoint.finish();
    }
    const retry = await capacity.reserveStaging(
      media + '/fourth.part',
      2 * MiB,
    );
    retry.release();
    assertEquals((await capacity.status()).filesystems[1].reservedBytes, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// Deterministic physical-space snapshots exercise the same admission as the
// real filesystem probe, without filling the shared guest or simulating an
// ENOSPC by changing the OS beneath the other tests.
async function mediaFixture(
  options: { budgetBytes?: number | null; probe?: CapacityProbe },
  run: (cache: MediaCache, root: string, capacity: Capacity) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: 'capacity-' });
  const mediaRoot = root + '/media';
  let store: Store | undefined;
  let cache: MediaCache | undefined;
  try {
    const storeRoot = root + '/store';
    const capacity = new Capacity(
      [storeRoot, mediaRoot],
      options.budgetBytes,
      options.probe,
    );
    store = await openStore(settingsFor(storeRoot), {
      schemas,
      capacityOwner: capacity,
    });
    cache = new MediaCache(
      await store.server(),
      mediaRoot,
      undefined,
      capacity,
    );
    await cache.start();
    await run(cache, mediaRoot, capacity);
  } finally {
    await cache?.close();
    await store?.close();
    await Deno.remove(root, { recursive: true });
  }
}

const cacheId = (mediaId: string, thumbnail = false) => ({
  origin: 'remote.test',
  mediaId,
  variant: thumbnail ? 'crop:1:1:png:false' : 'original',
  scope: thumbnail ? 'thumbnail' as const : 'remote' as const,
});
const publish = (
  cache: MediaCache,
  identity: ReturnType<typeof cacheId>,
  size: number,
) =>
  cache.fetch(
    identity,
    1,
    async (out) => {
      const writer = out.getWriter();
      try {
        await writer.write(new Uint8Array(size).fill(73));
        await writer.close();
      } finally {
        writer.releaseLock();
      }
      return { contentType: 'application/octet-stream', filename: null, size };
    },
    undefined,
    size,
  );

Deno.test('facade capacity: quota detection reports only the matching filesystem', async () => {
  const probe = (path: string) => ({
    device: path.endsWith('/media') ? 2 : 1,
    totalBytes: 128 * MiB,
    freeBytes: 64 * MiB,
    freeInodes: 1000,
    blockSize: 4096,
  });
  await mediaFixture({ probe }, async (cache, media, capacity) => {
    const { filesystems } = await capacity.status((path) =>
      Promise.resolve(path === media)
    );
    assertEquals(
      filesystems.map((disk) => [disk.device, disk.quotaBackstop]),
      [['1', false], ['2', true]],
    );
    assertEquals(
      (await publish(cache, cacheId('quota-diagnostic'), 16)).size,
      16,
    );
  });
});

Deno.test('facade capacity: each filesystem enforces its own default share', async () => {
  const totalBytes = 8 * MiB;
  const probe = (path: string) => {
    const media = path.includes('/media');
    const total = media ? totalBytes : 128 * MiB;
    return {
      device: media ? 2 : 1,
      totalBytes: total,
      freeBytes: total,
      freeInodes: 1000,
      blockSize: 4096,
    };
  };
  await mediaFixture({ probe }, async (cache) => {
    const large = cacheId('cannot-borrow-from-store');
    const refusal = await publish(cache, large, totalBytes - 4096).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      refusal instanceof Error && refusal.name === 'StoragePressureError',
      'media cannot borrow default budget from the larger store filesystem',
    );
    assertEquals(await cache.get(large), null);
    const small = cacheId('fits-its-own-filesystem');
    assertEquals((await publish(cache, small, MiB)).size, MiB);
  });
});

Deno.test('facade capacity: exhausted inodes prohibit new files even with the cap unset', async () => {
  let freeInodes = 1000;
  const probe = () => ({
    device: 1,
    totalBytes: 128 * MiB,
    freeBytes: 64 * MiB,
    freeInodes,
    blockSize: 4096,
  });
  await mediaFixture({ budgetBytes: null, probe }, async (cache) => {
    const previous = await publish(cache, cacheId('before-inode-full'), 16);
    const lease = await cache.open(previous);
    const next = cacheId('after-inode-full');
    freeInodes = 0;
    const refusal = await publish(cache, next, 16).then(
      () => null,
      (error: unknown) => error,
    );
    assert(
      refusal instanceof Error && refusal.name === 'StoragePressureError',
      'an unset software cap must not bypass physical inode exhaustion',
    );
    assertEquals(await cache.get(next), null);
    assertEquals(
      (await cache.get(cacheId('before-inode-full')))?.blob,
      previous.blob,
    );
    freeInodes = 1000;
    assertEquals((await publish(cache, next, 16)).size, 16);
    await lease.cancel();
  });
});

Deno.test('facade capacity review: disconnect cancels the owner waiting for staging', async () => {
  const queued = Promise.withResolvers<void>();
  let freeBytes = 32 * MiB;
  await mediaFixture({
    budgetBytes: null,
    probe: (path) => {
      if (path.endsWith('.part')) queued.resolve();
      return {
        totalBytes: 32 * MiB,
        freeBytes,
        freeInodes: 1000,
        device: 1,
        blockSize: 4096,
      };
    },
  }, async (cache, root, capacity) => {
    freeBytes = 4 * MiB;
    const holder = await capacity.reserveStaging(`${root}/held`, 3 * MiB);
    const controller = new AbortController();
    const disconnected = cache.fetch(
      cacheId('cancelled'),
      1,
      () => {
        throw new Error('cancelled producer must not run');
      },
      controller.signal,
      3 * MiB,
    );
    void disconnected.catch(() => {});
    const entered = Promise.withResolvers<void>();
    let next: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let marker: Awaited<ReturnType<Capacity['reserveStaging']>> | undefined;
    try {
      await queued.promise;
      // A later grant on the lane proves that the first attempt has left it.
      marker = await capacity.reserveStaging(`${root}/marker`, 0);
      controller.abort();
      await assertRejects(() => disconnected, DOMException, 'aborted');
      next = cache.fetch(
        cacheId('small'),
        1,
        async (out) => {
          entered.resolve();
          await out.getWriter().close();
          return { contentType: 'image/png', filename: null, size: 0 };
        },
        undefined,
        4096,
      );
      await Promise.race([
        entered.promise,
        next,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() =>
            reject(
              new Error('cancelled cache fill still owns a producer slot'),
            ), 1000);
        }),
      ]);
      await entered.promise;
    } finally {
      clearTimeout(timer);
      controller.abort();
      freeBytes = 32 * MiB;
      marker?.release();
      holder.release();
      await next?.catch(() => undefined);
    }
    assertEquals((await cache.get(cacheId('small')))?.size, 0);
  });
});

Deno.test('facade capacity review: a cache hit remains readable under timestamp write pressure', async () => {
  let freeBytes = 32 * MiB;
  const unexpected = new Error('unrelated I/O failure');
  let broken = false;
  await mediaFixture({
    probe: () => {
      if (broken) throw unexpected;
      return {
        totalBytes: 32 * MiB,
        freeBytes,
        freeInodes: 10,
        device: 1,
        blockSize: 4096,
      };
    },
  }, async (cache) => {
    const row = await publish(cache, cacheId('hit'), 4);
    freeBytes = 0;
    const stream = await cache.open(row);
    assertEquals(
      new Uint8Array(await new Response(stream).arrayBuffer()),
      new Uint8Array(4).fill(73),
    );
    broken = true;
    assertEquals(await assertRejects(() => cache.open(row)), unexpected);
  });
});

Deno.test('facade capacity: evicts the oldest eligible object, never leased bytes or an upload', async () => {
  await mediaFixture(
    { budgetBytes: 12 * MiB },
    async (cache, root, capacity) => {
      const protectedFile = root + '/previously-confirmed-upload';
      const protectedBytes = new Uint8Array(4096).fill(59);
      await Deno.writeFile(protectedFile, protectedBytes);
      const leased = cacheId('leased');
      const older = cacheId('older-eligible', true);
      const newer = cacheId('newer-eligible');
      const allocated = async (id: ReturnType<typeof cacheId>) => {
        const row = await cache.get(id);
        assert(row);
        return Number(
          (await lstat(cache.directory + '/' + row.blob, { bigint: true }))
            .blocks * 512n,
        );
      };
      const dateNow = Date.now;
      const start = dateNow();
      let tick = start;
      Date.now = () => ++tick;
      const lease = await (async () => {
        try {
          const pinned = await publish(cache, leased, 3 * MiB);
          const stream = await cache.open(pinned);
          const touched = await publish(cache, newer, 3 * MiB);
          await publish(cache, older, 3 * MiB);
          await (await cache.open(touched)).cancel();
          return stream;
        } finally {
          Date.now = dateNow;
        }
      })();
      try {
        const next = cacheId('new-admission');
        assertEquals(
          (await capacity.status()).filesystems[0].reclaimableBytes,
          await allocated(older) + await allocated(newer),
        );
        await assertRejects(
          () => publish(cache, next, 12 * MiB),
          StoragePressureError,
        );
        assertEquals((await cache.get(older))?.size, 3 * MiB);
        await publish(cache, next, 4 * MiB);
        assertEquals(
          await cache.get(older),
          null,
          'evict the oldest eligible bytes under pressure',
        );
        assertEquals((await cache.get(newer))?.size, 3 * MiB);
        assertEquals((await cache.get(leased))?.size, 3 * MiB);
        assertEquals((await cache.get(next))?.size, 4 * MiB);
        assertEquals(
          (await capacity.status()).filesystems[0].reclaimableBytes,
          await allocated(next) + await allocated(newer),
        );
        assertEquals(await Deno.readFile(protectedFile), protectedBytes);
        const read = new Uint8Array(await new Response(lease).arrayBuffer());
        assertEquals(read.byteLength, 3 * MiB);
        assert(read.every((value) => value === 73));
        // The pressure unlink leaves a stale index row; a miss refetches and
        // republishes it without manual cleanup or a process restart.
        assertEquals((await publish(cache, older, 1024)).size, 1024);
      } finally {
        if (!lease.locked) await lease.cancel();
      }
    },
  );
});

Deno.test('facade capacity: authenticated client upload maps storage pressure, not the request size limit', async (t) => {
  const root = await Deno.makeTempDir({ prefix: 'capacity-upload-' });
  const previous = config().media;
  const previousServer = config().server;
  const app = await startHttp();
  const contact = 'mailto:admin@logical.test';
  try {
    const user = await app.registerTestUser('capacity-upload', 'pw');
    const upload = async (size: number) => {
      const response = await app.matrix(
        new Request(
          'http://localhost/_matrix/media/v3/upload',
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${user.access_token!}`,
              'Content-Type': 'application/octet-stream',
              'Content-Length': String(size),
            },
            body: new Uint8Array(size),
          },
        ),
      );
      return { status: response.status, body: await response.json() };
    };
    setConfigForTests({ media: { root, maxbytes: 64 } });
    assertEquals((await upload(4)).status, 200);
    const open = Deno.open;
    let hits = 0;
    Deno.open = function (path, options) {
      if (
        typeof path === 'string' && path.startsWith(root + '/') &&
        path.endsWith('.part')
      ) {
        hits++;
        return Promise.reject(
          Object.assign(new Error('No space left on device'), {
            code: 'ENOSPC',
          }),
        );
      }
      return open(path, options);
    };
    try {
      await t.step(
        'without contact the retryable write returns 503',
        async () => {
          const refused = await upload(4);
          assertEquals(hits, 1);
          assertEquals(
            refused.status,
            503,
            'contactless client storage pressure must be retryable',
          );
          assert(!Object.hasOwn(refused.body, 'admin_contact'));
        },
      );
      await t.step(
        'configured contact receives the Matrix resource-limit response',
        async () => {
          const server = { ...config().server, admincontact: contact };
          setConfigForTests({ server, media: { root, maxbytes: 64 } });
          const refused = await upload(4);
          assertEquals(hits, 2);
          assertEquals(
            refused.status,
            403,
            'client storage pressure with contact must be 403',
          );
          assertEquals(refused.body.errcode, 'M_RESOURCE_LIMIT_EXCEEDED');
          assertEquals(refused.body.admin_contact, contact);
        },
      );
      await t.step(
        'an oversized body remains 413 even while writes fail',
        async () => {
          const before = hits;
          const oversized = await upload(65);
          assertEquals(hits, before, 'known oversized body must not stage');
          assertEquals(
            oversized.status,
            413,
            'request size must take precedence over storage pressure',
          );
          assertEquals(oversized.body.errcode, 'M_TOO_LARGE');
        },
      );
    } finally {
      Deno.open = open;
    }
    assertEquals((await upload(4)).status, 200);
  } finally {
    setConfigForTests({ server: previousServer, media: previous });
    await app.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: authenticated client upload claims its full staging bound before opening a file', async () => {
  const root = await Deno.makeTempDir({ prefix: 'capacity-upload-lease-' });
  const previous = config().media;
  const app = await startHttp();
  const KiB = 1024;
  const capacity = new Capacity([root], 160 * KiB);
  const upload = (bytes: number, maxBytes?: number) =>
    uploadMedia(
      app.app.tenant,
      'capacity-staging',
      new Blob([new Uint8Array(bytes)]).stream(),
      { content_type: 'application/octet-stream' },
      { capacity, maxBytes },
    );
  const open = Deno.open;
  let parts = 0;
  try {
    await app.registerTestUser('capacity-staging', 'pw');
    setConfigForTests({ media: { root, maxbytes: 256 * KiB } });
    Deno.open = function (path, options) {
      if (
        typeof path === 'string' && path.startsWith(root + '/') &&
        path.endsWith('.part')
      ) {
        parts++;
      }
      return open(path, options);
    };
    await assertRejects(() => upload(1), StoragePressureError);
    const competing = await capacity.reserveStaging(
      root + '/cache.part',
      96 * KiB,
    );
    try {
      await assertRejects(
        () => new Admission().run(() => upload(1, 1)),
        StorageBusyError,
      );
      assertEquals(parts, 0);
    } finally {
      competing.release();
    }
    await assertRejects(
      () => upload(2, 1),
      Error,
      'Upload exceeds the server limit',
    );
    assertEquals(Array.from(Deno.readDirSync(root)), []);
    const published = await upload(1, 1);
    assertEquals(
      await Deno.readFile(`${root}/${published.mediaId}`),
      new Uint8Array(1),
    );
    assertEquals((await capacity.status()).filesystems[0].reservedBytes, 0);
  } finally {
    Deno.open = open;
    setConfigForTests({ media: previous });
    await app.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('facade capacity: authenticated mTLS admission preserves both cuts and replays the exact record', async () => {
  const tls = await facadeTls();
  const open = (side: string) =>
    openStore(settingsFor(`${tls.dir}/${side}`), { schemas });
  let home: Store | undefined;
  let edge: Store | undefined;
  let wire: Awaited<ReturnType<typeof startLinkTransport>> | undefined;
  try {
    home = await open('home');
    edge = await open('edge');
    const tenant = await openTenant(home, 'logical.test', { create: true });
    const node = await initializeNode(
      await edge.server(),
      'logical.test',
      'edge_a',
    );
    const hp = new Pairings(
      await home.server(),
      tenant.signer(),
      tenant.publicB64,
      tls.homePin,
    );
    let fp = new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      tls.facadePin,
      node,
    );
    let journal = new Journal(await edge.server(), LINK_CAPABILITIES);
    const handler = () =>
      linkHandler({
        server: 'logical.test',
        node: node.node,
        incarnation: node.incarnation,
        journal,
        pairings: () => Promise.resolve(fp),
        notices: new NoticeHub(),
        limits: { maxItems: 100, maxBytes: 10000 },
        changed: () => Promise.resolve(),
      });
    let handle = handler();
    wire = await startLinkTransport({
      hostname: '127.0.0.1',
      port: 0,
      tls: tls.facade,
      authorize: (pin) => fp.allowsHome(pin),
      handle: (request, pin) => handle(request, pin),
    });
    const bundle = await hp.create({
      node: 'edge_a',
      url: wire.url,
      facadePin: tls.facadePin,
      expires: Date.now() + 60000,
      required: [...LINK_CAPABILITIES],
    });
    await fp.accept(bundle);
    await enrollLink(hp, bundle.id, tls.home, bundle.secret);
    const client = new LinkClient(tls.home, {
      url: wire.url,
      pin: tls.facadePin,
    });
    const stream = {
      source: 'home',
      incarnation: bundle.id,
      stream: 'control',
    };
    const records = async (items: LinkRecord[]) => {
      const response = await client.fetch('/_communico/link/v1/records', {
        method: 'POST',
        body: JSON.stringify({
          protocol: LINK_VERSION,
          server: bundle.server,
          required: LINK_CAPABILITIES,
          source: stream.source,
          incarnation: stream.incarnation,
          pairing: bundle.id,
          stream,
          records: items,
          after: EMPTY_CUT,
        }),
      });
      return { status: response.status, body: await response.json() };
    };
    const sender = new Journal(await home.server(), LINK_CAPABILITIES);
    const append = (operationId: string) =>
      sender.append('edge_a', {
        ...stream,
        type: 'control',
        version: 1,
        operationId,
        payload: { roster: [] },
      });
    const one = await append('first');
    const two = await append('retry-exactly');
    const cut = ({ sequence, hash }: LinkRecord) => ({ sequence, hash });
    assertEquals((await records([one])).status, 200);
    await journal.complete('home', stream, cut(one), { accepted: true });
    const previous = (await records([])).body.ack;
    assertEquals(previous.received, cut(one));
    assertEquals(previous.applied, cut(one));
    const commit = Turso.prototype.commit;
    let hits = 0;
    Turso.prototype.commit = function (connection) {
      if (hits++) return commit.call(this, connection);
      return Promise.reject(
        new StoreError(13, 'database or disk is full', 'DatabaseFull'),
      );
    };
    let refused;
    try {
      refused = await records([two]);
    } finally {
      Turso.prototype.commit = commit;
    }
    assert(hits > 0, 'authenticated record reached native commit');
    await edge.close();
    edge = await open('edge');
    fp = new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      tls.facadePin,
      node,
    );
    journal = new Journal(await edge.server(), LINK_CAPABILITIES);
    handle = handler();
    assertEquals((await records([])).body.ack, previous);
    const retry = await records([two]);
    assertEquals(retry.status, 200);
    assertEquals(retry.body.ack.received, cut(two));
    assertEquals(retry.body.ack.applied, cut(one));
    assertEquals((await records([two])).body.ack, retry.body.ack);
    assertEquals(
      refused.status,
      503,
      'authenticated link pressure must be retryable',
    );
  } finally {
    await wire?.close();
    await home?.close();
    await edge?.close();
    await tls.close();
  }
});

Deno.test('facade capacity: signed federation refuses on storage exhaustion and replays once after recovery', async (t) => {
  const tls = await facadeTls();
  const previousServer = config().server;
  setConfigForTests({ server: { name: 'logical.test' } });
  const facadeConfig = `${tls.dir}/edge.toml`;
  const homeConfig = `${tls.dir}/home.toml`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const budget = 16 * MiB;
  const storePath = `${tls.dir}/edge-store`;
  const filler = `${storePath}/protected-fixture`;
  const writeConfig = async (side: string, port: number, home = false) => {
    await Deno.writeTextFile(
      home ? homeConfig : facadeConfig,
      `[server]\nname="logical.test"\nrole="${
        home ? 'home' : 'facade'
      }"\nport=0\n` +
        `[store]\ndir="${tls.dir}/${side}-store"\n` +
        `[media]\nroot="${tls.dir}/${side}-media"\n` +
        `[admin]\nsocket="${tls.dir}/${side}.sock"\n` +
        `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${
          home ? 'home' : 'facade'
        }.crt"\n` +
        `key="${tls.dir}/${
          home ? 'home' : 'facade'
        }.key"\ncacerts=["${tls.dir}/ca.crt"]\n` +
        `[facade]\nnodeid="edge_a"\nurl="https://127.0.0.1:${port}"\nlinkport=${port}\n` +
        `linkcert="${tls.dir}/${
          home ? 'home' : 'facade'
        }.crt"\nlinkkey="${tls.dir}/${home ? 'home' : 'facade'}.key"\n` +
        `linkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
        (home
          ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n`
          : `storagebudgetbytes=${budget}\n`),
    );
  };
  let edge: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  let home: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  try {
    const remote = await makeServer('remote.test');
    const seed = await openStore(settingsFor(storePath), { schemas });
    try {
      await seedServer(await seed.server(), remote);
    } finally {
      await seed.close();
    }
    await writeConfig('edge', 0);
    edge = await facadeProcess(facadeConfig, 'facade: link/local admin ready');
    const linkPort = await edge.port('link');
    const local = (action = 'status', fields?: Record<string, unknown>) =>
      adminCall(`${tls.dir}/edge.sock`, `facade/${action}`, fields);
    assertEquals((await local('initialize')).status, 200);
    await writeConfig('home', linkPort, true);
    await fixtureLink(homeConfig, linkPort);
    home = await facadeProcess(homeConfig, 'federation: enabled');
    const paired = await adminCall(`${tls.dir}/home.sock`, 'facade/pair', {
      node: 'edge_a',
      url: `https://127.0.0.1:${linkPort}`,
      facadePin: tls.facadePin,
      expires: Date.now() + 60000,
      bundlefile,
    });
    assertEquals(paired.status, 200, JSON.stringify(paired));
    assertEquals((await local('accept', { bundlefile })).status, 200);
    await edge.observations.wait((event) =>
      event.kind === 'pairing' && event.id === paired.body.result.id &&
      event.state === 'paired'
    );
    await edge.observations.fact({
      peer: 'home',
      source: 'home',
      incarnation: paired.body.result.id,
      stream: 'directory',
    }, () => true);
    assert((await local()).body.result.scopes.some(
      (scope: { scope: string; ready: boolean }) =>
        scope.scope === 'directory' && scope.ready,
    ));
    await home.stop();
    home = undefined;
    let port = await edge.port('client');
    const call = fedCaller((request) => {
      const url = new URL(request.url);
      return fetch(
        new Request(
          `http://127.0.0.1:${port}${url.pathname}${url.search}`,
          request,
        ),
      );
    }, remote);
    const path = '/_matrix/federation/v1/send/';
    const body = {
      origin: remote.name,
      origin_server_ts: 1,
      pdus: [],
      edus: [{
        edu_type: 'm.direct_to_device',
        content: {
          sender: '@sender:remote.test',
          type: 'm.test',
          message_id: 'capacity-msg',
          messages: {
            '@recipient:logical.test': { '*': { payload: 'retained' } },
          },
        },
      }],
    };
    const previous = await call('PUT', path + 'previous', body);
    assertEquals(previous.status, 200, JSON.stringify(previous));
    const peer = 'edge_a';
    const inc = (await local()).body.result.incarnation;
    const stream = {
      source: peer,
      incarnation: inc,
      stream: 'ingress:remote.test',
    };
    const readCuts = async () => {
      const store = await openStore(settingsFor(storePath), { schemas });
      try {
        return await new Journal(await store.server(), LINK_CAPABILITIES).heads(
          'home',
          'out',
          stream,
        );
      } finally {
        await store.close();
      }
    };
    await edge.stop();
    edge = undefined;
    const saved = await readCuts();
    assertEquals(saved.received.sequence, 1, 'signed ingress owns this cut');
    await writeConfig('edge', linkPort);
    edge = await facadeProcess(facadeConfig, 'facade: link/local admin ready');
    port = await edge.port('client');
    await Deno.writeFile(filler, new Uint8Array(budget).fill(1));
    // External allocation is picked up at the explicit reconciliation boundary.
    assertEquals((await local()).status, 200);
    const rejected = await call('PUT', path + 'retry', body);
    assertEquals(
      rejected.status,
      503,
      'signed federation pressure must be retryable',
    );
    await t.step(
      'local status shows software budget exhaustion with physical space free',
      async () => {
        const response = await local();
        assertEquals(response.status, 200);
        const disks = response.body.result.capacity?.filesystems;
        assert(
          disks?.[0],
          'local status must report capacity on restart',
        );
        assertEquals(disks[0].budgetBytes, budget);
        assert(disks[0].usedBytes >= budget && disks[0].freeBytes > budget);
        assertEquals(disks[0].filesystemFull, false);
      },
    );
    await edge.stop();
    edge = undefined;
    const afterRefusal = await readCuts();
    await t.step(
      'signed ingress refuses retryably without advancing its cut',
      () => {
        assertEquals(afterRefusal, saved);
      },
    );
    await Deno.remove(filler);
    edge = await facadeProcess(facadeConfig, 'facade: link/local admin ready');
    port = await edge.port('client');
    assertEquals(await call('PUT', path + 'previous', body), previous);
    const recovered = await call('PUT', path + 'retry', body);
    assertEquals(recovered.status, 200);
    assertEquals(await call('PUT', path + 'retry', body), recovered);
    await t.step(
      'local status clears pressure after space returns',
      async () => {
        const disks = (await local()).body.result.capacity?.filesystems;
        assert(disks?.[0], 'local status must expose capacity after recovery');
        assert(disks[0].usedBytes < budget);
      },
    );
    await edge.stop();
    edge = undefined;
    const final = await readCuts();
    assertEquals(final.received.sequence, saved.received.sequence + 1);
  } finally {
    await home?.stop();
    await edge?.stop();
    setConfigForTests({ server: previousServer });
    await tls.close();
  }
});
