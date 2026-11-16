import { assert, assertEquals, assertRejects } from '@std/assert';
import type { LinkRecord } from '#engine/facade/protocol.ts';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
  exportSessionAuthority,
  startAccountExports,
} from '#engine/facade/accounts.ts';
import { DeviceOperations, type DeviceView } from '#engine/facade/devices.ts';
import { DomainOperations } from '#engine/facade/domain.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { bindRole } from '#engine/facade/role.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  recordHash,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  deleteDevices,
  updateDeviceName,
  upsertDevice,
} from '#engine/tenant/devices.ts';
import {
  importDeviceOperation,
  publicDeviceValues,
} from '#engine/tenant/device-operations.ts';
import type { DeviceOperation } from '#engine/tenant/device-source.ts';
import {
  appendImportedKeyNotice,
  rebaseRestoredDeviceStreams,
} from '#engine/tenant/changes.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { deviceListsBetween, deviceStreamMax } from '#engine/server/e2ee.ts';
import {
  pendingTenantProjection,
  tenantProjectionPending,
} from '#engine/tenant/hooks.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import {
  activateTenantAuthority,
  tenantAuthority,
} from '#engine/tenant/session-authority.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { captureSigningOperations } from '#engine/tenant/signing-operations.ts';
import { captureSignatureOperations } from '#engine/tenant/signature-operations.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

// Pause the real owner at deterministic cross-file boundaries. Revocation runs
// in the test task, never as a nested server transaction in the owner callback.
function pauseImport(store: Store, cut: 'before' | 'during' | 'after') {
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const tenant = store.tenant.bind(store);
  let paused = false;
  const pause = async () => {
    if (paused) return;
    paused = true;
    reached.resolve();
    await proceed.promise;
  };
  store.tenant = async (...args) => {
    const db = await tenant(...args);
    return {
      ...db,
      tx: async (fn, options) => {
        let imported = false;
        const result = await db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'query') {
                  return async (...args: Parameters<Conn['query']>) => {
                    const [sql] = args;
                    if (
                      cut === 'before' &&
                      sql.includes('facade_owner_activation')
                    ) await pause();
                    return await target.query(...args);
                  };
                }
                if (key === 'execute') {
                  return async (...args: Parameters<Conn['execute']>) => {
                    const value = await target.execute(...args);
                    if (
                      args[0].startsWith('INSERT INTO device_operations ') ||
                      args[0].startsWith('INSERT INTO signing_operations ') ||
                      args[0].startsWith('INSERT INTO signature_operations ') ||
                      args[0].startsWith(
                        'INSERT INTO key_bootstrap_publications ',
                      )
                    ) {
                      imported = true;
                      if (cut === 'during') await pause();
                    }
                    return value;
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options);
        if (imported && cut === 'after') await pause();
        return result;
      },
    };
  };
  return {
    reached: reached.promise,
    resume: () => proceed.resolve(),
    restore: () => {
      store.tenant = tenant;
    },
  };
}

async function fixture(publicFirst = false, legacyChanges = 0) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-device-link-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
  await bindRole(edge, {
    role: 'facade',
    server: 'logical.test',
    node: 'edge_a',
  });
  const ht = await openTenant(home, 'logical.test', { create: true });
  await ht.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  await upsertDevice(ht, 'alice', 'LAN', 'home name');
  for (let index = 0; index < legacyChanges; index++) {
    await updateDeviceName(ht, 'alice', 'LAN', 'legacy home ' + index);
  }
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    ht.signer(),
    ht.publicB64,
    'a'.repeat(64),
  );
  const fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  await hp.confirm(
    bundle.id,
    await fp.complete(
      bundle.id,
      await hp.grant(
        bundle.id,
        await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
      ),
      'a'.repeat(64),
    ),
  );
  const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const hj = new Journal(await home.server(), LINK_SUPPORTED),
    ej = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const control = await exportOwnerControl(home, ht, hp, bundle.id);
  await ej.receive('home', [control]);
  await owners.apply(ej, control);
  if (publicFirst) {
    const view = await ht.tx((tx) =>
      tx.publicReplica.export('alice', ht.serverName)
    );
    await et.tx((tx) => tx.publicReplica.install(view, et.serverName));
  }
  const accounts = new AccountSnapshots(home, ht, hp);
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await ej.receive('home', [auth]);
  await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  return {
    open,
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    node,
    bundle,
    hj,
    ej,
    owners,
    accounts,
    hs: new DeviceOperations(home, ht, hp),
    es: new DeviceOperations(edge, et, fp, node),
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('imported key news: receiver invalidation does not wake source authority exports', async () => {
  const f = await fixture();
  let exporter: ReturnType<typeof startAccountExports> | undefined;
  let stopNotice: (() => void) | undefined;
  try {
    const records = await f.hs.export('alice', f.bundle.id);
    assert(records.length > 0);
    const initial = Promise.withResolvers<void>();
    let captures = 0, notices = 0;
    exporter = startAccountExports({
      store: f.edge,
      tenant: f.et,
      pollseconds: config().facade.pollseconds,
      users: () => Promise.resolve(['alice']),
      emit: () => {
        captures++;
        initial.resolve();
        return Promise.resolve();
      },
      changed: () => {},
      failed: (error) => {
        throw error;
      },
    });
    await initial.promise;
    stopNotice = onTenantStream((store) => {
      if (store === f.edge) notices++;
    });
    for (const record of records) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    await exporter.close();
    assert(notices > 0, 'receiver clients still discover the committed news');
    assertEquals(
      captures,
      1,
      'imported client news is not local authority authoring',
    );
  } finally {
    stopNotice?.();
    await exporter?.close();
    await f.close();
  }
});

Deno.test('imported key news: device facts publish local ordinary and sliding news exactly once without echo or copied wire positions', async () => {
  const f = await fixture();
  const user = '@alice:logical.test';
  try {
    await projectTenant(f.edge, 'logical.test');
    const db = await f.edge.tenant('logical.test');
    const server = await f.edge.server();
    const before = await deviceStreamMax(server);
    const records = await f.hs.export('alice', f.bundle.id);
    let committed = 0;
    const off = onTenantStream((store, tenant) => {
      if (store === f.edge && tenant === 'logical.test') committed++;
    });
    try {
      for (const record of records) {
        await f.ej.receive('home', [record]);
        await f.es.apply(f.ej, record);
      }
      assert(
        await pendingTenantProjection(db) > 0,
        'import needs durable roll-forward intent',
      );
      assert(
        tenantProjectionPending(f.edge, 'logical.test'),
        'committed import must be discoverable without reopening the tenant',
      );
      assert(committed > 0, 'owner streams must wake after import commit');
      await projectTenant(f.edge, 'logical.test');
      const after = await deviceStreamMax(server);
      assert(after > before, 'receiver allocates its own client news');
      for (const scope of ['sync', 'keys'] as const) {
        assertEquals(
          await deviceListsBetween(server, user, before, after, scope),
          { changed: [user], left: [] },
        );
      }
      assertEquals(await f.es.export('alice'), []);
      assertEquals(await server.query('SELECT * FROM device_changes'), []);
      assertEquals(await server.query('SELECT * FROM device_publications'), []);
      assertEquals(await db.query('SELECT * FROM devices'), []);
      const [news] = await db.query('SELECT * FROM e2ee_changes');
      assertEquals(
        Number(news.stream_id),
        0,
        'client invalidation is not a new federation identity',
      );
      const count = committed;
      await projectTenant(f.edge, 'logical.test');
      assertEquals(await f.es.apply(f.ej, records[0]), false);
      assertEquals(await deviceStreamMax(server), after);
      assertEquals(committed, count);
    } finally {
      off();
    }
  } finally {
    await f.close();
  }
});

Deno.test('imported key news: facade facts reach home clients in the home publication domain', async () => {
  const f = await fixture();
  try {
    await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
    const authority = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    await f.hj.receive('edge_a', [authority]);
    await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
    await projectTenant(f.home, 'logical.test');
    const server = await f.home.server();
    const before = await deviceStreamMax(server);
    const own = await f.hs.export('alice', f.bundle.id);
    for (const record of await f.es.export('alice')) {
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const db = await f.home.tenant('logical.test');
    assert(await pendingTenantProjection(db) > 0);
    await projectTenant(f.home, 'logical.test');
    const after = await deviceStreamMax(server);
    assert(after > before);
    for (const scope of ['sync', 'keys'] as const) {
      assertEquals(
        await deviceListsBetween(
          server,
          '@alice:logical.test',
          before,
          after,
          scope,
        ),
        { changed: ['@alice:logical.test'], left: [] },
      );
    }
    assertEquals(await f.hs.export('alice', f.bundle.id), own);
    assertEquals(
      (await db.query('SELECT device_id FROM devices')).map((row) =>
        row.device_id
      ),
      ['LAN'],
    );
  } finally {
    await f.close();
  }
});

Deno.test('imported authority news: independently drained deletion removes keys and publishes receiver client news before a device suffix arrives', async () => {
  const f = await fixture();
  const user = '@alice:logical.test';
  try {
    const device = await deviceIdentity(f.ht, 'alice', 'LAN');
    await f.ht.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: {
              user_id: user,
              device_id: 'LAN',
              algorithms: [],
              keys: { 'ed25519:LAN': 'public-home-key' },
              signatures: {},
            },
          },
          user,
          'LAN',
          config().e2ee,
        ),
      )
    );
    for (const record of await f.hs.bootstrap('alice', f.bundle.id)) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    assertEquals(
      Object.keys(
        await f.et.tx((tx) => tx.e2ee.query('alice', [], user, user, 100)),
      ),
      ['LAN'],
    );
    await projectTenant(f.edge, 'logical.test');
    const server = await f.edge.server();
    const before = await deviceStreamMax(server);
    const db = await f.edge.tenant('logical.test');
    const oldFacts = await db.query(
      'SELECT * FROM device_operations ORDER BY operation_id',
    );
    await deleteDevices(f.ht, 'alice', ['LAN']);
    const auth = await exportAccountAuth(
      f.home,
      f.ht,
      f.hp,
      f.bundle.id,
      'alice',
      false,
    );
    await f.ej.receive('home', [auth]);
    await new AccountSnapshots(f.edge, f.et, f.fp, f.owners).apply(f.ej, auth);
    assertEquals(
      await f.et.tx((tx) => tx.e2ee.query('alice', [], user, user, 100)),
      {},
    );
    assertEquals(
      await db.query('SELECT * FROM device_operations ORDER BY operation_id'),
      oldFacts,
      'device suffix has not crossed',
    );
    assert(
      await pendingTenantProjection(db) > 0,
      'authority import must durably discover its changed public view',
    );
    assert(tenantProjectionPending(f.edge, 'logical.test'));
    await projectTenant(f.edge, 'logical.test');
    const after = await deviceStreamMax(server);
    assert(after > before);
    for (const scope of ['sync', 'keys'] as const) {
      assertEquals(
        await deviceListsBetween(server, user, before, after, scope),
        { changed: [user], left: [] },
      );
    }
    assertEquals(await f.es.export('alice'), []);
  } finally {
    await f.close();
  }
});

Deno.test('imported authority news: facade deletion reaches home clients without a new public device operation', async () => {
  const f = await fixture();
  try {
    await upsertDevice(f.et, 'alice', 'PHONE');
    const syncAuthority = async () => {
      const record = await exportSessionAuthority(
        f.edge,
        f.et,
        f.fp,
        f.owners,
        f.node,
        'alice',
      );
      await f.hj.receive('edge_a', [record]);
      await f.accounts.applyFromFacade(f.hj, f.bundle.id, record);
    };
    await syncAuthority();
    for (const record of await f.es.export('alice')) {
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const db = await f.home.tenant('logical.test');
    assert(
      (await db.tx((conn) => publicDeviceValues(conn, 'alice'))).some((op) =>
        op.deviceId === 'PHONE'
      ),
    );
    await projectTenant(f.home, 'logical.test');
    const server = await f.home.server();
    const before = await deviceStreamMax(server);
    const facts = await db.query(
      'SELECT * FROM device_operations ORDER BY operation_id',
    );
    await deleteDevices(f.et, 'alice', ['PHONE']);
    await syncAuthority();
    assertEquals(
      (await db.tx((conn) => publicDeviceValues(conn, 'alice'))).some((op) =>
        op.deviceId === 'PHONE'
      ),
      false,
    );
    assertEquals(
      await db.query('SELECT * FROM device_operations ORDER BY operation_id'),
      facts,
    );
    assert(await pendingTenantProjection(db) > 0);
    assert(tenantProjectionPending(f.home, 'logical.test'));
    await projectTenant(f.home, 'logical.test');
    const after = await deviceStreamMax(server);
    assert(after > before);
    for (const scope of ['sync', 'keys'] as const) {
      assertEquals(
        await deviceListsBetween(
          server,
          '@alice:logical.test',
          before,
          after,
          scope,
        ),
        { changed: ['@alice:logical.test'], left: [] },
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('imported key news: private signature notices retain subject and never become another observer news or federation work', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.tenant('logical.test');
    await projectTenant(f.edge, 'logical.test');
    const server = await f.edge.server();
    const before = await deviceStreamMax(server);
    await db.tx((conn) =>
      appendImportedKeyNotice(conn, 'alice', '@bob:remote.test', false)
    );
    await projectTenant(f.edge, 'logical.test');
    const head = await deviceStreamMax(server);
    for (const scope of ['sync', 'keys'] as const) {
      assertEquals(
        await deviceListsBetween(
          server,
          '@alice:logical.test',
          before,
          head,
          scope,
        ),
        { changed: ['@bob:remote.test'], left: [] },
      );
      assertEquals(
        await deviceListsBetween(
          server,
          '@eve:logical.test',
          before,
          head,
          scope,
        ),
        { changed: [], left: [] },
      );
    }
    assertEquals(await server.query('SELECT * FROM device_changes'), []);
    assertEquals(await server.query('SELECT * FROM device_publications'), []);
  } finally {
    await f.close();
  }
});

Deno.test('imported key news: signing and signature imports retain durable discoverable client news', async () => {
  const f = await fixture();
  try {
    await signatureInput(f);
    const db = await f.edge.tenant('logical.test');
    const server = await f.edge.server();
    await projectTenant(f.edge, 'logical.test');
    const signing = await f.hs.exportSigning('alice', f.bundle.id);
    const signatures = await f.hs.exportSignatures('alice', f.bundle.id);
    for (const records of [signing, signatures]) {
      assert(records.length > 0);
      const before = await deviceStreamMax(server);
      for (const record of records) {
        await f.ej.receive('home', [record]);
        await f.es.apply(f.ej, record);
      }
      assert(
        await pendingTenantProjection(db) > 0,
        'every imported key kind needs durable discovery',
      );
      assert(tenantProjectionPending(f.edge, 'logical.test'));
      await projectTenant(f.edge, 'logical.test');
      const after = await deviceStreamMax(server);
      assert(
        after > before,
        'each imported key kind reaches the local consumer',
      );
      for (const scope of ['sync', 'keys'] as const) {
        assertEquals(
          await deviceListsBetween(
            server,
            '@alice:logical.test',
            before,
            after,
            scope,
          ),
          { changed: ['@alice:logical.test'], left: [] },
        );
      }
      for (const record of records) {
        assertEquals(await f.es.apply(f.ej, record), false);
      }
      await projectTenant(f.edge, 'logical.test');
      assertEquals(await deviceStreamMax(server), after);
    }
    assertEquals(await f.es.exportSignatures('alice'), []);
    assertEquals(await f.es.export('alice'), []);
  } finally {
    await f.close();
  }
});

Deno.test('imported key news: rollback has no intent or wake; committed ACK loss cold-replays one consumer publication', async () => {
  const f = await fixture();
  try {
    const [record] = await f.hs.export('alice', f.bundle.id);
    await f.ej.receive('home', [record]);
    const db = await f.edge.tenant('logical.test');
    await projectTenant(f.edge, 'logical.test');
    const beforeNews = await db.query('SELECT * FROM e2ee_changes');
    const operation = (record.payload as { body: DeviceView }).body.operation;
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          await importDeviceOperation(conn, operation, operation);
          throw new Error('rollback imported news');
        }),
      Error,
      'rollback imported news',
    );
    assertEquals(await db.query('SELECT * FROM e2ee_changes'), beforeNews);
    assertEquals(await pendingTenantProjection(db), 0);
    f.ej.complete = () => Promise.reject(new Error('news ACK loss'));
    await assertRejects(() => f.es.apply(f.ej, record), Error, 'news ACK loss');
    assertEquals(
      (await db.query('SELECT * FROM e2ee_changes')).length,
      beforeNews.length + 1,
    );
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const pairings = new Pairings(
        await reopened.server(),
        f.node.signer(),
        f.node.publicKey,
        'b'.repeat(64),
        f.node,
      );
      const tenant = await enrolledTenant(
        reopened,
        pairings,
        'logical.test',
        'edge_a',
      );
      assert(tenantProjectionPending(reopened, 'logical.test'));
      const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
      const owner = new DeviceOperations(reopened, tenant, pairings, f.node);
      await owner.apply(journal, record);
      await projectTenant(reopened, 'logical.test');
      const server = await reopened.server();
      const after = await deviceStreamMax(server);
      assert(after > 0);
      for (const scope of ['sync', 'keys'] as const) {
        assertEquals(
          await deviceListsBetween(
            server,
            '@alice:logical.test',
            0,
            after,
            scope,
          ),
          { changed: ['@alice:logical.test'], left: [] },
        );
      }
      assertEquals(await owner.apply(journal, record), false);
      await projectTenant(reopened, 'logical.test');
      assertEquals(await deviceStreamMax(server), after);
      assertEquals(
        (await (await reopened.tenant('logical.test')).query(
          'SELECT * FROM e2ee_changes',
        )).length,
        beforeNews.length + 1,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('device wire lanes: first offline facade creation cannot reuse the legacy home serial namespace', async () => {
  const f = await fixture(false, 6);
  try {
    const homeDb = await f.home.tenant('logical.test');
    const legacy = await homeDb.query(
      'SELECT stream_id FROM e2ee_changes ORDER BY pos',
    );
    const used = legacy.map((row) => Number(row.stream_id));
    assert(
      used.includes(2),
      'the former serial namespace already used the facade lane',
    );
    // No device/public snapshot has crossed the link. Only the signed account
    // bootstrap grants this first offline login; its allocation floor must be
    // present before a new device can publish anything.
    await upsertDevice(f.et, 'alice', 'FIRST', 'first offline device');
    const edgeDb = await f.edge.tenant('logical.test');
    const [row] = await edgeDb.query(
      'SELECT stream_id FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    assert(
      Number(row.stream_id) > Math.max(...used),
      'new lane must start beyond every legacy home identity',
    );
    assertEquals(Number(row.stream_id) % 2, 0);
    const [baseline] = await edgeDb.query(
      'SELECT floor FROM device_stream_baselines WHERE localpart=?',
      ['alice'],
    );
    assertEquals(Number(baseline.floor), Math.max(...used));
    await updateDeviceName(f.ht, 'alice', 'LAN', 'new signed home publication');
    const refreshed = await exportAccountAuth(
      f.home,
      f.ht,
      f.hp,
      f.bundle.id,
      'alice',
      false,
    );
    const signed =
      (refreshed.payload as { signed: { body: { deviceStreamFloor: number } } })
        .signed;
    assertEquals(
      signed.body.deviceStreamFloor,
      Number(baseline.floor),
      'auth refresh does not manufacture newer checkpoints',
    );
  } finally {
    await f.close();
  }
});

Deno.test('device wire lanes: a replacement incarnation cannot reuse the held role lane through authority activation', async () => {
  const f = await fixture();
  try {
    await upsertDevice(f.et, 'alice', 'PHONE');
    for (const store of [f.home, f.edge]) {
      const db = await store.tenant('logical.test');
      const held = await db.tx(tenantAuthority);
      assert(held);
      const before = await db.query('SELECT * FROM device_stream_baselines');
      const replacement = {
        ...held,
        edgeIncarnation: 'replacement-store',
        ...(held.node === 'home' ? {} : { incarnation: 'replacement-store' }),
      };
      await assertRejects(
        () => db.tx((conn) => activateTenantAuthority(conn, replacement)),
        MatrixError,
        'operation owner unavailable at this ingress',
      );
      assertEquals(await db.tx(tenantAuthority), held);
      assertEquals(
        await db.query('SELECT * FROM device_stream_baselines'),
        before,
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('device wire lanes: missing signed home baseline refuses effects instead of using an old serial snapshot', async () => {
  const f = await fixture();
  try {
    const db = await f.edge.tenant('logical.test');
    const beforeNews = await db.query('SELECT * FROM e2ee_changes');
    await db.execute('DELETE FROM device_stream_baselines');
    await assertRejects(
      () => upsertDevice(f.et, 'alice', 'PHONE'),
      MatrixError,
      'home allocation baseline',
    );
    assertEquals(await db.query('SELECT * FROM devices'), []);
    assertEquals(
      await db.query('SELECT * FROM device_stream_publications'),
      [],
    );
    assertEquals(await db.query('SELECT * FROM user_device_stream'), []);
    assertEquals(await db.query('SELECT * FROM e2ee_changes'), beforeNews);
  } finally {
    await f.close();
  }
});

Deno.test('device wire lanes: signed source identities survive exchange and the next owner joins observed tips', async () => {
  const f = await fixture();
  type Wire = { streamId: number; prevIds: number[] };
  const wireOf = (op: unknown) => (op as { wire?: Wire }).wire;
  const viewOf = (record: LinkRecord) =>
    (record.payload as { body: DeviceView }).body;
  try {
    const homeDb = await f.home.tenant('logical.test');
    const edgeDb = await f.edge.tenant('logical.test');
    const records = await f.hs.export('alice', f.bundle.id);
    const homeOps = records.map((r) => viewOf(r).operation);
    assert(homeOps.length > 0);
    for (const op of homeOps) {
      const wire = wireOf(op);
      assert(
        wire,
        'signed owner source must retain its original wire publication',
      );
      assertEquals(wire.streamId % 2, 1, 'home uses its signed odd lane');
    }
    await f.ej.receive('home', records);
    for (const record of records) await f.es.apply(f.ej, record);
    await upsertDevice(f.et, 'alice', 'PHONE', 'outside phone');
    await updateDeviceName(f.ht, 'alice', 'LAN', 'concurrent home change');
    const [concurrent] = await homeDb.query(
      'SELECT payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    const homeTip =
      JSON.parse(String(concurrent.payload)).operation.wire.streamId;
    const authority = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    await f.hj.receive('edge_a', [authority]);
    await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
    const reverse = await f.es.export('alice');
    assert(reverse.length > 0);
    for (const record of reverse) {
      const op = viewOf(record).operation;
      const wire = wireOf(op);
      assert(wire);
      assertEquals(wire.streamId % 2, 0, 'facade uses its signed even lane');
      assert(wire.prevIds.includes(wireOf(homeOps.at(-1)!)!.streamId));
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
      const [retained] = await homeDb.query(
        'SELECT payload_json FROM device_operations WHERE operation_id=?',
        [op.operationId],
      );
      assertEquals(
        JSON.parse(String(retained.payload_json)),
        op,
        'import does not allocate a replacement wire identity',
      );
    }
    await updateDeviceName(f.ht, 'alice', 'LAN', 'after import');
    const [last] = await homeDb.query(
      'SELECT payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    const local = JSON.parse(String(last.payload));
    const lastRemote = wireOf(viewOf(reverse.at(-1)!).operation)!;
    assertEquals(
      local.operation.wire.prevIds,
      [lastRemote.streamId, homeTip].sort((a, b) => a - b),
    );
    assertEquals(local.wire, local.operation.wire);
    assertEquals(
      await f.es.export('alice'),
      reverse,
      'reads and retries reuse exact source publications',
    );
    const frontier = await edgeDb.query(
      'SELECT stream_id FROM device_stream_frontier WHERE localpart=?',
      ['alice'],
    );
    assertEquals(frontier.map((row) => Number(row.stream_id)), [
      lastRemote.streamId,
    ]);
  } finally {
    await f.close();
  }
});

Deno.test('device wire lanes: wrong lanes, changed identities and cycles roll back; a delayed ancestor stays consumed after cold reopen', async () => {
  const f = await fixture();
  let reopened;
  try {
    const [record] = await f.hs.export('alice', f.bundle.id);
    const original = (record.payload as { body: DeviceView }).body.operation;
    const expected = {
      source: original.source,
      incarnation: original.incarnation,
      localpart: 'alice',
    };
    const op = (
      sequence: number,
      streamId: number,
      prevIds: number[],
    ): DeviceOperation => {
      const { payloadHash: _hash, ...source } = original;
      const body = {
        ...source,
        sequence,
        operationId: canonicalJson([
          source.source,
          source.incarnation,
          'device',
          sequence,
        ]),
        wire: { streamId, prevIds },
      };
      return {
        ...body,
        payloadHash: createHash('sha256').update(canonicalJson(body)).digest(
          'hex',
        ),
      };
    };
    const db = await f.edge.tenant('logical.test');
    const apply = (operation: DeviceOperation) =>
      db.tx((conn) => importDeviceOperation(conn, operation, expected));
    await assertRejects(
      () => apply(op(100, 12, [])),
      MatrixError,
      'wire publication collision',
    );
    assertEquals(await db.query('SELECT * FROM device_operations'), []);
    const child = op(101, 11, [13]);
    await apply(child);
    await assertRejects(
      () => apply(op(102, 11, [13])),
      MatrixError,
      'wire publication collision',
    );
    await assertRejects(
      () => apply(op(102, 13, [11])),
      MatrixError,
      'wire publication collision',
    );
    assertEquals(
      (await db.query('SELECT stream_id FROM device_stream_frontier')).map((
        r,
      ) => Number(r.stream_id)),
      [11],
    );
    await apply(op(102, 13, []));
    await apply(child);
    assertEquals(
      (await db.query('SELECT stream_id FROM device_stream_frontier')).map((
        r,
      ) => Number(r.stream_id)),
      [11],
    );
    assertEquals(
      (await db.query('SELECT * FROM device_stream_publications')).length,
      2,
    );
    await f.edge.close();
    reopened = await f.open('edge');
    const cold = await reopened.tenant('logical.test');
    assertEquals(
      (await cold.query('SELECT stream_id FROM device_stream_frontier')).map((
        r,
      ) => Number(r.stream_id)),
      [11],
    );
    const tenant = await openTenant(reopened, 'logical.test');
    await upsertDevice(tenant, 'alice', 'PHONE', 'after cold import');
    const [last] = await cold.query(
      'SELECT payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    const wire = JSON.parse(String(last.payload)).wire;
    assertEquals(
      wire.streamId,
      2,
      'imported positions do not become the local source allocator',
    );
    assertEquals(wire.prevIds, [11]);
  } finally {
    await reopened?.close();
    await f.close();
  }
});

Deno.test('device wire lanes: rollback, restart and private restore never reuse the signed lane', async () => {
  const f = await fixture();
  let reopened;
  try {
    await f.hs.export('alice', f.bundle.id);
    const db = await f.home.tenant('logical.test');
    const before = await db.query(
      'SELECT * FROM device_stream_publications ORDER BY stream_id',
    );
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          await conn.execute(
            "UPDATE facade_owner_activation SET body_hash='incomplete-control'",
          );
          await rebaseRestoredDeviceStreams(conn);
        }),
      MatrixError,
      'device stream awaits ownership control',
    );
    assertEquals(
      await db.query(
        'SELECT * FROM device_stream_publications ORDER BY stream_id',
      ),
      before,
    );
    await assertRejects(
      () =>
        db.tx(async (conn) => {
          await rebaseRestoredDeviceStreams(conn);
          throw new Error('rollback private restore');
        }),
      Error,
      'rollback private restore',
    );
    assertEquals(
      await db.query(
        'SELECT * FROM device_stream_publications ORDER BY stream_id',
      ),
      before,
    );
    await db.tx((conn) => rebaseRestoredDeviceStreams(conn));
    const [reset] = await db.query(
      'SELECT stream_id,payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    const resetWire = JSON.parse(String(reset.payload)).wire;
    assertEquals(Number(reset.stream_id) % 2, 1);
    assertEquals(resetWire.streamId, Number(reset.stream_id));
    assertEquals(resetWire.prevIds, []);
    await f.home.close();
    reopened = await f.open('home');
    const tenant = await openTenant(reopened, 'logical.test');
    await updateDeviceName(tenant, 'alice', 'LAN', 'after restore restart');
    const cold = await reopened.tenant('logical.test');
    const [last] = await cold.query(
      'SELECT stream_id,payload FROM e2ee_changes ORDER BY pos DESC LIMIT 1',
    );
    assertEquals(Number(last.stream_id), Number(reset.stream_id) + 2);
    assert(
      JSON.parse(String(last.payload)).wire.prevIds.includes(
        Number(reset.stream_id),
      ),
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

Deno.test('F2 public evidence cannot replace semantic account state in either bootstrap order or after cold reopen', async () => {
  for (const publicFirst of [false, true]) {
    const f = await fixture(publicFirst);
    let reopened;
    try {
      const domains = await new DomainOperations(f.home, f.ht, f.hp).bootstrap(
        'alice',
        f.bundle.id,
      );
      const receiver = new DomainOperations(f.edge, f.et, f.fp, f.node);
      await f.ej.receive('home', domains);
      for (const record of domains) await receiver.apply(f.ej, record);
      const cuts = {
        '!kept:logical.test': { changePos: 3, segment: 1, group: 2 },
      };
      await f.et.tx(async (tx) => {
        await tx.profiles.set('alice', 'displayname', 'Outside profile');
        await tx.erasure.mark('alice', cuts);
      });
      await upsertDevice(f.et, 'alice', 'PHONE', 'Outside phone');
      await f.ht.tx((tx) =>
        tx.profiles.set('alice', 'displayname', 'Home profile')
      );
      const view = await f.ht.tx((tx) =>
        tx.publicReplica.export('alice', f.ht.serverName)
      );
      await f.et.tx((tx) => tx.publicReplica.install(view, f.et.serverName));
      await f.et.tx((tx) => tx.publicReplica.install(view, f.et.serverName));
      // F1 terminal evidence is not an authenticated F2 deactivation operation.
      const terminal = { ...view, cut: view.cut + 1, deactivated: true };
      await f.et.tx((tx) =>
        tx.publicReplica.install(terminal, f.et.serverName)
      );
      await f.edge.close();
      reopened = await f.open('edge');
      const tenant = await openTenant(reopened, 'logical.test');
      assertEquals(
        (await tenant.tx((tx) => tx.users.byLocalpart('alice')))?.deactivated,
        false,
      );
      assertEquals(
        (await tenant.tx((tx) => tx.profiles.get('alice')))?.displayname,
        'Outside profile',
      );
      assertEquals(
        await tenant.tx((tx) => tx.erasure.get('alice', '!kept:logical.test')),
        cuts['!kept:logical.test'],
      );
      const db = await reopened.tenant('logical.test');
      assertEquals(
        (await db.query(
          'SELECT snapshot_json FROM public_user_replicas WHERE localpart=?',
          ['alice'],
        ))[0].snapshot_json,
        canonicalJson(terminal),
      );
      assertEquals(
        (await tenant.tx((tx) => tx.devices.byId('PHONE', 'alice')))
          ?.display_name,
        'Outside phone',
      );
      // Selection is per account; activation alone never converts owned users.
      await tenant.tx((tx) => tx.users.insert('unselected', 'Unselected'));
      await assertRejects(
        () =>
          tenant.tx((tx) =>
            tx.publicReplica.install({
              ...view,
              userId: '@unselected:logical.test',
              devices: {
                user_id: '@unselected:logical.test',
                stream_id: 0,
                devices: [],
              },
              signing: {},
            }, tenant.serverName)
          ),
        MatrixError,
        'owned account',
      );
    } finally {
      await reopened?.close();
      await f.close();
    }
  }
});

async function signingInput() {
  const user = '@alice:logical.test';
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const input: Record<string, unknown> = {
    master_key: {
      user_id: user,
      usage: ['master'],
      keys: { ['ed25519:' + pub]: pub },
    },
  };
  for (const usage of ['self_signing', 'user_signing']) {
    const subordinate = await generateSigningKeypair() as CryptoKeyPair;
    const key = b64encodeStd(await exportPublicKeyRaw(subordinate.publicKey));
    const json = {
      user_id: user,
      usage: [usage],
      keys: { ['ed25519:' + key]: key },
    };
    await signJson(json, user, 'ed25519:' + pub, pair.privateKey);
    input[usage + '_key'] = json;
  }
  return signingUpload(input, user, config().e2ee);
}

async function signatureInput(
  f: Awaited<ReturnType<typeof fixture>>,
  side: 'home' | 'edge' = 'home',
) {
  const tenant = side === 'home' ? f.ht : f.et;
  const deviceId = side === 'home' ? 'LAN' : 'PHONE';
  const user = '@alice:logical.test';
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  await upsertDevice(tenant, 'alice', deviceId);
  const device = await deviceIdentity(tenant, 'alice', deviceId);
  await tenant.tx((tx) =>
    tx.e2ee.upload(
      device,
      validateUpload(
        {
          device_keys: {
            user_id: user,
            device_id: deviceId,
            algorithms: [],
            keys: { ['ed25519:' + deviceId]: pub },
            signatures: {},
          },
        },
        user,
        deviceId,
        config().e2ee,
      ),
    )
  );
  const input = await signingInput();
  await f.ht.tx((tx) =>
    tx.crossSigning.upload('alice', user, input, '{}', false)
  );
  if (side === 'edge') {
    const records = await f.hs.exportSigning('alice', f.bundle.id);
    await f.ej.receive('home', records);
    for (const record of records) await f.es.apply(f.ej, record);
  }
  const master = JSON.parse(input.master!.json);
  const id = Object.values(master.keys as Record<string, string>)[0];
  await signJson(master, user, 'ed25519:' + deviceId, pair.privateKey);
  assertEquals(
    await tenant.tx((tx) =>
      tx.keySignatures.upload('alice', user, [{
        user,
        id,
        json: master,
      }])
    ),
    { failures: {} },
  );
  const db = await (side === 'home' ? f.home : f.edge).tenant('logical.test');
  const [operation] = await db.tx((conn) =>
    captureSignatureOperations(conn, 'alice')
  );
  assert(operation);
  return operation;
}

Deno.test('semantic key bootstrap: exact complete manifest waits for independently drained facts and survives cold ACK loss', async () => {
  const f = await fixture(true);
  let reopened;
  try {
    await signatureInput(f);
    const exporter = f.hs as DeviceOperations & {
      bootstrap(localpart: string, pairing: string): Promise<LinkRecord[]>;
    };
    const records = await exporter.bootstrap('alice', f.bundle.id);
    const marker = records.find((record) => record.type === 'key-bootstrap');
    assert(marker);
    assertEquals(await exporter.bootstrap('alice', f.bundle.id), records);
    for (const record of records) await f.ej.receive('home', [record]);
    await assertRejects(
      () => f.es.apply(f.ej, marker),
      Error,
      'awaits retained key facts',
    );
    const db = await f.edge.tenant('logical.test');
    assertEquals(
      await db.query('SELECT * FROM key_bootstrap_publications'),
      [],
    );
    for (const record of records.filter((record) => record !== marker)) {
      await f.es.apply(f.ej, record);
    }
    const complete = f.ej.complete.bind(f.ej);
    f.ej.complete = () => Promise.reject(new Error('bootstrap ACK loss'));
    await assertRejects(
      () => f.es.apply(f.ej, marker),
      Error,
      'bootstrap ACK loss',
    );
    assertEquals(
      (await db.query('SELECT * FROM key_bootstrap_publications')).length,
      1,
    );
    f.ej.complete = complete;
    await f.edge.close();
    reopened = await f.open('edge');
    const pairings = new Pairings(
      await reopened.server(),
      f.node.signer(),
      f.node.publicKey,
      'b'.repeat(64),
      f.node,
    );
    const tenant = await enrolledTenant(
      reopened,
      pairings,
      'logical.test',
      'edge_a',
    );
    const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
    const receiver = new DeviceOperations(reopened, tenant, pairings, f.node);
    assertEquals(await receiver.apply(journal, marker), true);
    assertEquals(
      (await journal.streams('home', 'in')).find((stream) =>
        stream.stream === marker.stream
      )?.applied.sequence,
      marker.sequence,
    );
    assertEquals(
      (await (await reopened.tenant('logical.test')).query(
        'SELECT * FROM key_bootstrap_publications',
      )).length,
      1,
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

Deno.test('semantic key bootstrap: an empty selected account still has authenticated completeness', async () => {
  const f = await fixture();
  try {
    const exporter = f.hs as DeviceOperations & {
      bootstrap(localpart: string, pairing: string): Promise<LinkRecord[]>;
    };
    const auth = await exportAccountAuth(
      f.home,
      f.ht,
      f.hp,
      f.bundle.id,
      'bob',
      false,
    );
    await f.ej.receive('home', [auth]);
    await new AccountSnapshots(f.edge, f.et, f.fp, f.owners).apply(f.ej, auth);
    const records = await exporter.bootstrap('bob', f.bundle.id);
    const marker = records.find((record) => record.type === 'key-bootstrap');
    assert(marker);
    for (const record of records) await f.ej.receive('home', [record]);
    for (const record of records) await f.es.apply(f.ej, record);
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM key_bootstrap_publications',
      )).length,
      1,
    );
    assertEquals(
      records.filter((record) => record.type === 'device-operation'),
      [],
    );
    await assertRejects(
      () => exporter.bootstrap('unselected', f.bundle.id),
      Error,
      'not selected',
    );
  } finally {
    await f.close();
  }
});

Deno.test('semantic key bootstrap: home retained history preserves original identity and cannot replace the current signing identity', async () => {
  const f = await fixture();
  try {
    await signatureInput(f);
    const home = await f.home.tenant('logical.test');
    const [current] = await home.tx((conn) =>
      captureSigningOperations(conn, 'alice')
    );
    const { payloadHash: _hash, ...body } = current;
    const oldBody = {
      ...body,
      incarnation: 'retained-home-incarnation',
      operationId: canonicalJson([
        'home',
        'retained-home-incarnation',
        'signing',
        current.sequence,
      ]),
      keys: [],
    };
    const prior = {
      ...oldBody,
      payloadHash: createHash('sha256').update(canonicalJson(oldBody)).digest(
        'hex',
      ),
    };
    await home.execute('INSERT INTO signing_operations VALUES(?,?,?,?,?,?)', [
      prior.operationId,
      prior.source,
      prior.incarnation,
      prior.sequence,
      prior.localpart,
      canonicalJson(prior),
    ]);
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    const historical = records.find((record) => record.type === 'key-history');
    assert(historical);
    for (const record of records) await f.ej.receive('home', [record]);
    // Delayed historical arrival must not clear a newer active identity.
    for (
      const record of records.filter((record) =>
        record.type !== 'key-bootstrap' && record !== historical
      )
    ) await f.es.apply(f.ej, record);
    const db = await f.edge.tenant('logical.test');
    const before = await db.query(
      'SELECT * FROM cross_signing_keys ORDER BY usage',
    );
    assert(before.length > 0);
    await f.es.apply(f.ej, historical);
    assertEquals(
      await db.query('SELECT * FROM cross_signing_keys ORDER BY usage'),
      before,
    );
    assertEquals(
      JSON.parse(
        String(
          (await db.query(
            'SELECT payload_json FROM signing_operations WHERE operation_id=?',
            [prior.operationId],
          ))[0].payload_json,
        ),
      ),
      prior,
    );
    for (
      const marker of records.filter((record) =>
        record.type === 'key-bootstrap'
      )
    ) await f.es.apply(f.ej, marker);
    const { importSigningOperation } = await import(
      '#engine/tenant/signing-operations.ts'
    );
    await assertRejects(
      () => db.tx((conn) => importSigningOperation(conn, prior, prior)),
      Error,
      'collision',
    );
    assertEquals(await f.es.exportSigning('alice'), []);
  } finally {
    await f.close();
  }
});

async function retainedDevice(
  f: Awaited<ReturnType<typeof fixture>>,
  withWire = false,
) {
  const db = await f.home.tenant('logical.test');
  const [row] = await db.query(
    "SELECT payload FROM authority_facts WHERE localpart='alice' AND kind='device'",
  );
  const creation = {
    ...JSON.parse(String(row.payload)),
    incarnation: 'retained-home-device',
    deviceId: 'OLD',
  };
  creation.id = canonicalJson([
    creation.node,
    creation.incarnation,
    creation.seq,
  ]);
  const [record] = await f.hs.export('alice', f.bundle.id);
  const original = (record.payload as { body: DeviceView }).body.operation;
  const { payloadHash: _hash, wire: _wire, ...body } = original;
  const oldBody = {
    ...body,
    incarnation: creation.incarnation,
    deviceId: creation.deviceId,
    deviceIncarnation: creation.id,
    ...(withWire ? { wire: { streamId: 101, prevIds: [] } } : {}),
    operationId: canonicalJson([
      creation.node,
      creation.incarnation,
      'device',
      original.sequence,
    ]),
  };
  const operation = {
    ...oldBody,
    payloadHash: createHash('sha256').update(canonicalJson(oldBody)).digest(
      'hex',
    ),
  };
  await db.tx(async (conn) => {
    await conn.execute('INSERT INTO authority_facts VALUES(?,?,?,?,?,?,?)', [
      creation.id,
      creation.node,
      creation.incarnation,
      creation.seq,
      creation.localpart,
      creation.kind,
      canonicalJson(creation),
    ]);
    await conn.execute(
      'INSERT INTO device_operations VALUES(?,?,?,?,?,?,?,?,?)',
      [
        operation.operationId,
        operation.source,
        operation.incarnation,
        operation.sequence,
        operation.localpart,
        operation.deviceId,
        operation.deviceIncarnation,
        operation.payloadHash,
        canonicalJson(operation),
      ],
    );
  });
  return { creation, operation };
}

Deno.test('semantic key historical device creation: fresh receiver retains exact passive closure without session authority', async () => {
  for (const mode of [0, 1, 2, 3]) {
    const historyFirst = mode % 2 === 1;
    const f = await fixture();
    try {
      const { creation, operation } = await retainedDevice(f, mode >= 2);
      const records = await f.hs.bootstrap('alice', f.bundle.id);
      const historical = records.find((record) =>
        record.type === 'key-history'
      )!;
      const marker = records.find((record) => record.type === 'key-bootstrap')!;
      assert(historical);
      const db = await f.edge.tenant('logical.test');
      const before = await db.query(
        'SELECT * FROM authority_facts ORDER BY id',
      );
      for (const record of records) await f.ej.receive('home', [record]);
      await assertRejects(
        () => f.es.apply(f.ej, marker),
        Error,
        'awaits retained key facts',
      );
      const dependencies = records.filter((record) =>
        record !== marker && record !== historical
      );
      for (
        const record of historyFirst
          ? [historical, ...dependencies]
          : [...dependencies, historical]
      ) {
        await f.es.apply(f.ej, record);
      }
      await f.es.apply(f.ej, marker);
      assertEquals(
        await db.query('SELECT * FROM authority_facts ORDER BY id'),
        before,
      );
      assertEquals(await db.query('SELECT * FROM authority_devices'), []);
      assertEquals(await db.query('SELECT * FROM devices'), []);
      assertEquals(await db.query('SELECT * FROM one_time_keys'), []);
      assertEquals(await db.query('SELECT * FROM session_authority'), []);
      assertEquals(
        JSON.parse(
          String(
            (await db.query(
              'SELECT payload_json FROM device_creation_history WHERE id=?',
              [creation.id],
            ))[0].payload_json,
          ),
        ),
        creation,
      );
      assertEquals(
        JSON.parse(
          String(
            (await db.query(
              'SELECT payload_json FROM device_operations WHERE operation_id=?',
              [operation.operationId],
            ))[0].payload_json,
          ),
        ),
        operation,
      );
      assertEquals(
        (await db.tx((conn) => publicDeviceValues(conn, 'alice'))).map((
          value,
        ) => value.deviceId),
        ['LAN'],
      );
      assertEquals(await f.es.export('alice'), []);
    } finally {
      await f.close();
    }
  }
});

function rehashHistory(record: LinkRecord) {
  const signed = record.payload as { body: unknown };
  record.operationId = 'key-history:' +
    createHash('sha256').update(canonicalJson(signed.body)).digest('hex');
  const { hash: _hash, ...body } = record;
  record.hash = recordHash(body);
}

Deno.test('semantic key historical device creation: altered closure, account, control and signatures never gain passive or active authority', async () => {
  for (
    const fault of [
      'creation',
      'identity',
      'account',
      'control',
      'unsigned',
    ] as const
  ) {
    const f = await fixture();
    try {
      await retainedDevice(f);
      const records = await f.hs.bootstrap('alice', f.bundle.id);
      const record = records.find((record) => record.type === 'key-history')!;
      const signed = record.payload as {
        body: import('#engine/tenant/key-bootstrap.ts').KeyHistory;
        signature: string;
      };
      if (fault === 'creation') signed.body.creation!.deviceId = 'FORGED';
      else if (fault === 'identity') signed.body.creation!.seq++;
      else if (fault === 'account') signed.body.localpart = 'bob';
      else if (fault === 'control') signed.body.ownerRevision++;
      else signed.body.creation!.deviceId = 'UNSIGNED';
      if (fault !== 'unsigned') {
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      rehashHistory(record);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record));
      const db = await f.edge.tenant('logical.test');
      assertEquals(await db.query('SELECT * FROM device_creation_history'), []);
      assertEquals(await db.query('SELECT * FROM device_operations'), []);
      assertEquals(await db.query('SELECT * FROM devices'), []);
    } finally {
      await f.close();
    }
  }
});

Deno.test('semantic key historical device creation: source refuses missing original evidence instead of signing a substitute', async () => {
  const f = await fixture();
  try {
    const { creation } = await retainedDevice(f);
    await (await f.home.tenant('logical.test')).execute(
      'DELETE FROM authority_facts WHERE id=?',
      [creation.id],
    );
    await assertRejects(
      () => f.hs.bootstrap('alice', f.bundle.id),
      Error,
      'awaits original device creation',
    );
  } finally {
    await f.close();
  }
});

Deno.test('semantic key historical device creation: retirement rolls passive closure back with operation and receipt', async () => {
  for (const cut of ['before', 'during'] as const) {
    const f = await fixture();
    let pause;
    try {
      await retainedDevice(f);
      const record = (await f.hs.bootstrap('alice', f.bundle.id)).find((
        record,
      ) => record.type === 'key-history')!;
      await f.ej.receive('home', [record]);
      pause = pauseImport(f.edge, cut);
      const rejected = assertRejects(() => f.es.apply(f.ej, record));
      await pause.reached;
      await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      pause.resume();
      await rejected;
      pause.restore();
      const db = await f.edge.tenant('logical.test');
      assertEquals(await db.query('SELECT * FROM device_creation_history'), []);
      assertEquals(await db.query('SELECT * FROM device_operations'), []);
      assertEquals(
        (await f.ej.heads('home', 'in', record)).applied.sequence,
        0,
      );
    } finally {
      pause?.resume();
      pause?.restore();
      await f.close();
    }
  }
});

Deno.test('semantic key historical device creation: exact passive closure survives cold ACK loss without becoming active', async () => {
  const f = await fixture();
  let reopened;
  try {
    const { creation, operation } = await retainedDevice(f);
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    const record = records.find((record) => record.type === 'key-history')!;
    for (const record of records) await f.ej.receive('home', [record]);
    for (
      const dependency of records.filter((candidate) =>
        candidate !== record && candidate.type !== 'key-bootstrap'
      )
    ) await f.es.apply(f.ej, dependency);
    const complete = f.ej.complete.bind(f.ej);
    f.ej.complete = () => Promise.reject(new Error('historical ACK loss'));
    await assertRejects(
      () => f.es.apply(f.ej, record),
      Error,
      'historical ACK loss',
    );
    f.ej.complete = complete;
    await f.edge.close();
    reopened = await f.open('edge');
    const pairings = new Pairings(
      await reopened.server(),
      f.node.signer(),
      f.node.publicKey,
      'b'.repeat(64),
      f.node,
    );
    const tenant = await enrolledTenant(
      reopened,
      pairings,
      'logical.test',
      'edge_a',
    );
    const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
    const receiver = new DeviceOperations(reopened, tenant, pairings, f.node);
    assertEquals(await receiver.apply(journal, record), true);
    assertEquals(await receiver.apply(journal, record), false);
    await receiver.apply(
      journal,
      records.find((record) => record.type === 'key-bootstrap')!,
    );
    const db = await reopened.tenant('logical.test');
    assertEquals(
      JSON.parse(
        String(
          (await db.query(
            'SELECT payload_json FROM device_creation_history WHERE id=?',
            [creation.id],
          ))[0].payload_json,
        ),
      ),
      creation,
    );
    assertEquals(
      (await db.query('SELECT * FROM device_operations WHERE operation_id=?', [
        operation.operationId,
      ])).length,
      1,
    );
    assertEquals(
      await db.query('SELECT * FROM authority_facts WHERE id=?', [creation.id]),
      [],
    );
    assertEquals(await db.query('SELECT * FROM devices'), []);
    assertEquals(await db.query('SELECT * FROM session_authority'), []);
    assertEquals(
      (await db.tx((conn) => publicDeviceValues(conn, 'alice'))).map((value) =>
        value.deviceId
      ),
      ['LAN'],
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

Deno.test('semantic key bootstrap: revocation before or during declaration admission leaves neither readiness nor receipt', async () => {
  for (const cut of ['before', 'during'] as const) {
    const f = await fixture();
    let pause;
    try {
      const records = await f.hs.bootstrap('alice', f.bundle.id);
      const marker = records.find((record) => record.type === 'key-bootstrap')!;
      for (const record of records) await f.ej.receive('home', [record]);
      for (const record of records.filter((record) => record !== marker)) {
        await f.es.apply(f.ej, record);
      }
      pause = pauseImport(f.edge, cut);
      const applying = f.es.apply(f.ej, marker);
      const rejected = assertRejects(() => applying);
      await pause.reached;
      await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      pause.resume();
      await rejected;
      pause.restore();
      const db = await f.edge.tenant('logical.test');
      assertEquals(
        await db.query('SELECT * FROM key_bootstrap_publications'),
        [],
      );
      assertEquals(
        (await f.ej.streams('home', 'in')).find((stream) =>
          stream.stream === marker.stream
        )?.applied.sequence,
        0,
      );
    } finally {
      pause?.resume();
      pause?.restore();
      await f.close();
    }
  }
});

Deno.test('semantic key bootstrap: missing, changed, duplicate or unsigned declaration facts cannot gain readiness', async () => {
  for (
    const fault of ['missing', 'changed', 'duplicate', 'unsigned'] as const
  ) {
    const f = await fixture();
    try {
      const records = await f.hs.bootstrap('alice', f.bundle.id);
      const marker = records.find((record) => record.type === 'key-bootstrap')!;
      const signed = marker.payload as {
        body: import('#engine/tenant/key-bootstrap.ts').KeyBootstrap;
        signature: string;
      };
      const refs = signed.body.manifest['device-operation'];
      assert(refs.length);
      if (fault === 'missing') {
        refs.push({
          operationId: 'not-retained',
          payloadHash: 'a'.repeat(64),
        });
      } else if (fault === 'changed') refs[0].payloadHash = 'b'.repeat(64);
      else if (fault === 'duplicate') refs.push(refs[0]);
      else signed.body.ownerRevision++;
      if (fault !== 'unsigned') {
        refs.sort((a, b) =>
          a.operationId < b.operationId
            ? -1
            : a.operationId > b.operationId
            ? 1
            : 0
        );
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      marker.operationId = 'key-bootstrap:' +
        createHash('sha256').update(canonicalJson(signed.body)).digest('hex');
      const { hash: _hash, ...material } = marker;
      marker.hash = recordHash(material);
      for (const record of records) await f.ej.receive('home', [record]);
      for (
        const record of records.filter((record) => record !== marker)
      ) await f.es.apply(f.ej, record);
      await assertRejects(
        () => f.es.apply(f.ej, marker),
        Error,
        fault === 'missing'
          ? 'awaits retained key facts'
          : fault === 'changed'
          ? 'key fact changed'
          : fault === 'duplicate'
          ? 'duplicate key manifest fact'
          : 'invalid device operation signature',
      );
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM key_bootstrap_publications',
        ),
        [],
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('semantic key bootstrap: home can return exact edge signature history without changing its source or creating an echo', async () => {
  const f = await fixture();
  try {
    const signature = await signatureInput(f, 'edge');
    const reverse = await f.es.exportSignatures('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const db = await f.edge.tenant('logical.test');
    await db.execute('DELETE FROM signature_operations WHERE operation_id=?', [
      signature.operationId,
    ]);
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    for (const record of records) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    const restored = (await db.query(
      'SELECT payload_json FROM signature_operations WHERE operation_id=?',
      [signature.operationId],
    ))[0];
    assertEquals(JSON.parse(String(restored.payload_json)), signature);
    assertEquals(await f.es.exportSignatures('alice'), reverse);
    assertEquals(await db.query('SELECT * FROM one_time_keys'), []);
  } finally {
    await f.close();
  }
});

Deno.test('semantic key readers: authenticated baseline merges home and edge keys without F1 overwrite or user-signing disclosure', async () => {
  for (const publicFirst of [false, true]) {
    const f = await fixture(publicFirst);
    try {
      await signatureInput(f);
      const user = '@alice:logical.test';
      await upsertDevice(f.et, 'alice', 'PHONE', 'outside phone');
      const phone = await deviceIdentity(f.et, 'alice', 'PHONE');
      await f.et.tx((tx) =>
        tx.e2ee.upload(
          phone,
          validateUpload(
            {
              device_keys: {
                user_id: user,
                device_id: 'PHONE',
                algorithms: [],
                keys: { 'ed25519:PHONE': 'edge-public' },
                signatures: {},
              },
            },
            user,
            'PHONE',
            config().e2ee,
          ),
        )
      );
      const query = () =>
        f.et.tx((tx) =>
          tx.e2ee.query('alice', [], user, user, config().e2ee.maxkeys)
        );
      // A partial semantic suffix is not a complete home baseline.
      await assertRejects(query, MatrixError, 'key bootstrap unavailable');
      const view = await f.ht.tx((tx) =>
        tx.publicReplica.export('alice', f.ht.serverName)
      );
      await f.et.tx((tx) => tx.publicReplica.install(view, f.et.serverName));
      const records = await f.hs.bootstrap('alice', f.bundle.id);
      for (const record of records) {
        await f.ej.receive('home', [record]);
        await f.es.apply(f.ej, record);
      }
      assertEquals(Object.keys(await query()).sort(), ['LAN', 'PHONE']);
      const snapshot = await f.et.tx((tx) =>
        tx.e2ee.snapshot('alice', user, config().e2ee)
      );
      assertEquals(
        (snapshot.devices as { device_id: string }[]).map((device) =>
          device.device_id
        ).sort(),
        ['LAN', 'PHONE'],
      );
      const own = await f.et.tx((tx) =>
        tx.crossSigning.views('alice', user, user)
      );
      const other = await f.et.tx((tx) =>
        tx.crossSigning.views('alice', user, '@bob:logical.test')
      );
      assert(own.user_signing_keys);
      assertEquals(other.user_signing_keys, undefined);
      assertEquals(Object.keys(other).sort(), [
        'master_keys',
        'self_signing_keys',
      ]);
      // Retained F1 public evidence may arrive again, but cannot hide PHONE.
      await f.et.tx((tx) => tx.publicReplica.install(view, f.et.serverName));
      assertEquals(Object.keys(await query()).sort(), ['LAN', 'PHONE']);
      const authority = await exportSessionAuthority(
        f.edge,
        f.et,
        f.fp,
        f.owners,
        f.node,
        'alice',
      );
      await f.hj.receive('edge_a', [authority]);
      await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
      for (const record of await f.es.export('alice')) {
        await f.hj.receive('edge_a', [record]);
        await f.hs.apply(f.hj, record, f.bundle.id);
      }
      assertEquals(
        Object.keys(
          await f.ht.tx((tx) =>
            tx.e2ee.query('alice', [], user, user, config().e2ee.maxkeys)
          ),
        ).sort(),
        ['LAN', 'PHONE'],
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('semantic key public scope: missing account selection never exposes raw keys or signing material', async () => {
  for (const publicFirst of [false, true]) {
    const f = await fixture(publicFirst);
    try {
      await signatureInput(f, 'edge');
      const db = await f.edge.tenant('logical.test');
      await db.execute(
        "DELETE FROM account_auth_snapshots WHERE localpart='alice'",
      );
      const user = '@alice:logical.test';
      for (
        const reader of [
          () =>
            f.et.tx((tx) =>
              tx.e2ee.query('alice', [], user, user, config().e2ee.maxkeys)
            ),
          () =>
            f.et.tx((tx) =>
              tx.e2ee.query('alice', [], '', user, config().e2ee.maxkeys)
            ),
          () => f.et.tx((tx) => tx.e2ee.snapshot('alice', user, config().e2ee)),
          () => f.et.tx((tx) => tx.crossSigning.views('alice', user, user)),
          () => f.et.tx((tx) => tx.crossSigning.views('alice', user, '')),
        ]
      ) await assertRejects(reader, MatrixError, 'key bootstrap unavailable');
    } finally {
      await f.close();
    }
  }
});

Deno.test('semantic key public scope: actual F1-only evidence remains exact and never falls through to raw owner keys', async () => {
  const f = await fixture();
  try {
    const user = '@bob:logical.test';
    const readers = [
      () =>
        f.et.tx((tx) =>
          tx.e2ee.query('bob', [], user, user, config().e2ee.maxkeys)
        ),
      () =>
        f.et.tx((tx) =>
          tx.e2ee.query('bob', [], '', user, config().e2ee.maxkeys)
        ),
      () => f.et.tx((tx) => tx.e2ee.snapshot('bob', user, config().e2ee)),
      () => f.et.tx((tx) => tx.crossSigning.views('bob', user, user)),
      () => f.et.tx((tx) => tx.crossSigning.views('bob', user, '')),
    ];
    for (const reader of readers) {
      await assertRejects(reader, MatrixError, 'key bootstrap unavailable');
    }
    const view = await f.ht.tx((tx) =>
      tx.publicReplica.export('bob', f.ht.serverName)
    );
    await f.et.tx((tx) => tx.publicReplica.install(view, f.et.serverName));
    await assertRejects(
      () => upsertDevice(f.et, 'bob', 'NEW'),
      MatrixError,
      'home allocation baseline',
    );
    // Unselected legacy/corrupt raw rows are not an admission capability. Seed
    // that read-boundary input directly, not through a new owner publication
    // without a signed account baseline.
    const db = await f.edge.tenant('logical.test');
    await db.execute("INSERT INTO devices VALUES('RAW','bob',1,NULL)");
    await db.execute('INSERT INTO device_keys VALUES(?,?,?,?)', [
      'bob',
      'RAW',
      1,
      canonicalJson({
        user_id: user,
        device_id: 'RAW',
        algorithms: [],
        keys: { 'ed25519:RAW': 'raw-public' },
        signatures: {},
      }),
    ]);
    assertEquals(await readers[0](), {});
    assertEquals(await readers[1](), {});
    assertEquals(await readers[2](), view.devices);
    assertEquals(await readers[3](), view.signing);
    assertEquals(await readers[4](), view.signing);
  } finally {
    await f.close();
  }
});

Deno.test('semantic key public scope: enrolled foreign-device signature reaches both public key consumers and survives cold reopen', async () => {
  const f = await fixture(true);
  let reopened;
  try {
    const user = '@alice:logical.test';
    const masterPair = await generateSigningKeypair() as CryptoKeyPair;
    const selfPair = await generateSigningKeypair() as CryptoKeyPair;
    const masterKey = b64encodeStd(
      await exportPublicKeyRaw(masterPair.publicKey),
    );
    const selfKey = b64encodeStd(await exportPublicKeyRaw(selfPair.publicKey));
    const master = {
      user_id: user,
      usage: ['master'],
      keys: { ['ed25519:' + masterKey]: masterKey },
    };
    const self = {
      user_id: user,
      usage: ['self_signing'],
      keys: { ['ed25519:' + selfKey]: selfKey },
    };
    await signJson(self, user, 'ed25519:' + masterKey, masterPair.privateKey);
    await f.ht.tx((tx) =>
      tx.crossSigning.upload(
        'alice',
        user,
        signingUpload(
          { master_key: master, self_signing_key: self },
          user,
          config().e2ee,
        ),
        '{}',
        false,
      )
    );
    const device = await deviceIdentity(f.ht, 'alice', 'LAN');
    const keys = {
      user_id: user,
      device_id: 'LAN',
      algorithms: [],
      keys: { 'ed25519:LAN': 'home-public' },
      signatures: {},
    };
    await f.ht.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload({ device_keys: keys }, user, 'LAN', config().e2ee),
      )
    );
    for (const record of await f.hs.bootstrap('alice', f.bundle.id)) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    const signed = structuredClone(keys);
    await signJson(signed, user, 'ed25519:' + selfKey, selfPair.privateKey);
    assertEquals(
      await f.et.tx((tx) =>
        tx.keySignatures.upload('alice', user, [{
          user,
          id: 'LAN',
          json: signed,
        }])
      ),
      { failures: {} },
    );
    const publicQuery = (tenant: typeof f.ht) =>
      tenant.tx((tx) =>
        tx.e2ee.query('alice', ['LAN'], user, user, config().e2ee.maxkeys)
      );
    const expected = {
      ...signed,
      unsigned: { device_display_name: 'home name' },
    };
    assertEquals((await publicQuery(f.et)).LAN, expected);
    for (const record of await f.es.exportSignatures('alice')) {
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(await publicQuery(f.ht), await publicQuery(f.et));
    const snapshot = await f.et.tx((tx) =>
      tx.e2ee.snapshot('alice', user, config().e2ee)
    );
    assertEquals(
      (snapshot.devices as { device_id: string; keys: unknown }[]).map((
        device,
      ) => [device.device_id, device.keys]),
      [['LAN', expected]],
    );
    await f.edge.close();
    reopened = await f.open('edge');
    const active = await openTenant(reopened, 'logical.test');
    assertEquals(await publicQuery(active), await publicQuery(f.ht));
    const db = await reopened.tenant('logical.test');
    assertEquals(await db.query('SELECT * FROM devices'), []);
    assertEquals(await db.query('SELECT * FROM one_time_keys'), []);
    await deactivateUser(active, 'alice');
    assert((await db.query('SELECT * FROM signing_operations')).length > 0);
    assertEquals(await publicQuery(active), {});
    assertEquals(
      (await active.tx((tx) => tx.e2ee.snapshot('alice', user, config().e2ee)))
        .devices,
      [],
    );
    assertEquals(
      await active.tx((tx) => tx.crossSigning.views('alice', user, user)),
      {},
    );
  } finally {
    await reopened?.close();
    await f.close();
  }
});

Deno.test('key runtime export retains independent signing streams when device export is unavailable', async () => {
  const f = await fixture();
  try {
    await signatureInput(f);
    f.hs.export = () => Promise.reject(new Error('device export unavailable'));
    await assertRejects(
      () => f.hs.exportChanges('alice', f.bundle.id),
      Error,
      'device export unavailable',
    );
    for (const prefix of ['signing:', 'signatures:']) {
      assert(
        (await f.hj.streams('edge_a', 'out')).some((stream) =>
          stream.stream === prefix + '@alice:logical.test' &&
          stream.received.sequence > 0
        ),
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('signature link: a signed portable overlay is applied before its journal ACK', async () => {
  const f = await fixture();
  try {
    const operation = await signatureInput(f);
    const [template] = await f.hs.export('alice', f.bundle.id);
    const view = {
      ...(template.payload as { body: DeviceView }).body,
      kind: 'signature-operation',
      operation,
    };
    const body = {
      ...template,
      stream: 'signatures:@alice:logical.test',
      type: 'signature-operation',
      operationId: 'signature:' + createHash('sha256').update(canonicalJson([
        f.bundle.id,
        view.grantRevision,
        view.ownerRevision,
        operation.operationId,
      ])).digest('hex'),
      payload: {
        body: view,
        signature: await f.ht.signer().sign(canonicalJson(view)),
      },
    };
    const { hash: _hash, ...unsigned } = body;
    const record = { ...unsigned, hash: recordHash(unsigned) };
    const journal = new Journal(await f.edge.server(), [...LINK_SUPPORTED, {
      type: 'signature-operation',
      version: 1,
    }]);
    await journal.receive('home', [record]);
    assertEquals(await f.es.apply(journal, record), true);
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT payload_json FROM signature_operations',
      )).map((row) => JSON.parse(String(row.payload_json))),
      [operation],
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.hash,
      record.hash,
    );
  } finally {
    await f.close();
  }
});

Deno.test('signature link: both selected sources export original overlays without echo or device/pool authority', async () => {
  for (const side of ['home', 'edge'] as const) {
    const f = await fixture();
    try {
      const operation = await signatureInput(f, side);
      const owner = side === 'home' ? f.hs : f.es;
      const receiver = side === 'home' ? f.es : f.hs;
      const journal = side === 'home' ? f.ej : f.hj;
      const peer = side === 'home' ? 'home' : 'edge_a';
      const records = await owner.exportSignatures(
        'alice',
        side === 'home' ? f.bundle.id : undefined,
      );
      assertEquals(records.length, 1);
      assertEquals(records[0].type, 'signature-operation');
      assertEquals(records[0].stream, 'signatures:@alice:logical.test');
      assertEquals(
        await owner.exportSignatures(
          'alice',
          side === 'home' ? f.bundle.id : undefined,
        ),
        records,
      );
      await journal.receive(peer, records);
      assertEquals(
        await receiver.apply(
          journal,
          records[0],
          side === 'edge' ? f.bundle.id : undefined,
        ),
        true,
      );
      assertEquals(
        await receiver.apply(
          journal,
          records[0],
          side === 'edge' ? f.bundle.id : undefined,
        ),
        false,
      );
      const db = await (side === 'home' ? f.edge : f.home).tenant(
        'logical.test',
      );
      assertEquals(
        (await db.query('SELECT payload_json FROM signature_operations')).map((
          row,
        ) => JSON.parse(String(row.payload_json))),
        [operation],
      );
      assertEquals(
        await receiver.exportSignatures(
          'alice',
          side === 'edge' ? f.bundle.id : undefined,
        ),
        [],
      );
      assertEquals(await db.query('SELECT * FROM device_operations'), []);
      assertEquals(await db.query('SELECT * FROM one_time_keys'), []);
      await assertRejects(
        () =>
          owner.exportSignatures(
            'bob',
            side === 'home' ? f.bundle.id : undefined,
          ),
        Error,
        'account not selected',
      );
    } finally {
      await f.close();
    }
  }
  assert(
    LINK_SUPPORTED.some((cap) =>
      cap.type === 'signature-operation' && cap.version === 1
    ),
  );
  assertEquals(
    LINK_CAPABILITIES.some((cap) => cap.type === 'signature-operation'),
    false,
  );
});

Deno.test('signature link: changed signed scope, type or bytes never imports or ACKs an overlay', async () => {
  for (
    const fault of [
      'signature',
      'source',
      'localpart',
      'grantRevision',
      'stream',
      'type',
    ] as const
  ) {
    const f = await fixture();
    try {
      await signatureInput(f);
      const [record] = await f.hs.exportSignatures('alice', f.bundle.id);
      const signed = record.payload as {
        body: Record<string, unknown>;
        signature: string;
      };
      if (fault === 'signature') signed.signature = 'A'.repeat(86);
      else if (fault === 'stream') {
        record.stream = 'signing:@alice:logical.test';
      } else if (fault === 'type') record.type = 'signing-operation';
      else {
        signed.body[fault] = fault === 'source'
          ? 'edge_a'
          : fault === 'localpart'
          ? 'bob'
          : Number(signed.body.grantRevision) + 1;
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      const { hash: _hash, ...body } = record;
      record.hash = recordHash(body);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM signature_operations',
        ),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signature link: current control, selection and pairing fence overlay admission', async () => {
  for (const fault of ['control', 'selection', 'revoked'] as const) {
    const f = await fixture();
    try {
      await signatureInput(f);
      const [record] = await f.hs.exportSignatures('alice', f.bundle.id);
      await f.ej.receive('home', [record]);
      const db = await f.edge.tenant('logical.test');
      if (fault === 'control') {
        await db.tx((conn) =>
          conn.execute('DELETE FROM facade_owner_activation')
        );
      } else if (fault === 'selection') {
        await db.tx((conn) =>
          conn.execute(
            'UPDATE account_auth_snapshots SET grant_revision=grant_revision+1',
          )
        );
      } else await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(await db.query('SELECT * FROM signature_operations'), []);
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signature link: revocation before or during overlay admission rolls back fact and receipt', async () => {
  for (const side of ['home', 'edge'] as const) {
    for (const cut of ['before', 'during'] as const) {
      const f = await fixture();
      try {
        await signatureInput(f, side === 'home' ? 'edge' : 'home');
        const records = side === 'home'
          ? await f.es.exportSignatures('alice')
          : await f.hs.exportSignatures('alice', f.bundle.id);
        const store = side === 'home' ? f.home : f.edge;
        const owner = side === 'home' ? f.hs : f.es;
        const journal = side === 'home' ? f.hj : f.ej;
        const peer = side === 'home' ? 'edge_a' : 'home';
        await journal.receive(peer, records);
        const paused = pauseImport(store, cut);
        const outcome = owner.apply(
          journal,
          records[0],
          side === 'home' ? f.bundle.id : undefined,
        ).then(() => null, (error) => error);
        try {
          await Promise.race([
            paused.reached,
            outcome.then((error) => {
              throw error ??
                new Error('overlay admission did not reach its cut');
            }),
          ]);
          const revoked = await f.hp.revoke(f.bundle.id);
          if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
        } finally {
          paused.resume();
          paused.restore();
        }
        assert(await outcome instanceof Error);
        const db = await store.tenant('logical.test');
        assertEquals(await db.query('SELECT * FROM signature_operations'), []);
        assertEquals(
          await db.query('SELECT * FROM facade_link_applications'),
          [],
        );
        assertEquals(
          (await journal.next(peer, records[0]))?.hash,
          records[0].hash,
        );
      } finally {
        await f.close();
      }
    }
  }
});

Deno.test('signature link: admitted overlay survives retirement and ACK loss across actual cold reopen', async () => {
  for (const side of ['home', 'edge'] as const) {
    const f = await fixture();
    try {
      await signatureInput(f, side === 'home' ? 'edge' : 'home');
      const records = side === 'home'
        ? await f.es.exportSignatures('alice')
        : await f.hs.exportSignatures('alice', f.bundle.id);
      const store = side === 'home' ? f.home : f.edge;
      const owner = side === 'home' ? f.hs : f.es;
      const journal = side === 'home' ? f.hj : f.ej;
      const peer = side === 'home' ? 'edge_a' : 'home';
      await journal.receive(peer, records);
      const paused = pauseImport(store, 'after');
      journal.complete = () =>
        Promise.reject(new Error('injected signature ACK loss'));
      const outcome = owner.apply(
        journal,
        records[0],
        side === 'home' ? f.bundle.id : undefined,
      ).then(() => null, (error) => error);
      try {
        await Promise.race([
          paused.reached,
          outcome.then((error) => {
            throw error ?? new Error('overlay admission did not reach its cut');
          }),
        ]);
        const revoked = await f.hp.revoke(f.bundle.id);
        if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      const error = await outcome;
      assert(
        error instanceof Error &&
          error.message === 'injected signature ACK loss',
      );
      await store.close();
      const reopened = await f.open(side);
      try {
        const pairings = side === 'edge'
          ? new Pairings(
            await reopened.server(),
            f.node.signer(),
            f.node.publicKey,
            'b'.repeat(64),
            f.node,
          )
          : new Pairings(
            await reopened.server(),
            f.ht.signer(),
            f.ht.publicB64,
            'a'.repeat(64),
          );
        const coldJournal = new Journal(
          await reopened.server(),
          LINK_SUPPORTED,
        );
        const coldOwner = new DeviceOperations(
          reopened,
          side === 'edge' ? f.et : f.ht,
          pairings,
          side === 'edge' ? f.node : undefined,
        );
        assertEquals(
          await coldOwner.apply(
            coldJournal,
            records[0],
            side === 'home' ? f.bundle.id : undefined,
          ),
          true,
        );
        assertEquals(
          (await coldJournal.heads(peer, 'in', records[0])).applied.hash,
          records[0].hash,
        );
        assertEquals(
          (await (await reopened.tenant('logical.test')).query(
            'SELECT * FROM signature_operations',
          )).length,
          1,
        );
        assertEquals(
          await coldOwner.apply(
            coldJournal,
            records[0],
            side === 'home' ? f.bundle.id : undefined,
          ),
          false,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test('device link: current owner facts cross the signed journal without granting mutable authority or echoing', async () => {
  const f = await fixture();
  try {
    const records = await f.hs.export('alice', f.bundle.id);
    assert(records.length > 0, 'home public device intent must reach the link');
    for (const record of records) {
      await f.ej.receive('home', [record]);
      assertEquals(await f.es.apply(f.ej, record), true);
    }
    const db = await f.edge.tenant('logical.test');
    assertEquals(
      (await db.tx((conn) => publicDeviceValues(conn, 'alice'))).map((
        op,
      ) => [op.deviceId, op.value?.displayName]),
      [['LAN', 'home name']],
    );
    assertEquals(await db.query('SELECT * FROM devices'), []);
    assertEquals(await f.es.export('alice'), []);
    await upsertDevice(f.et, 'alice', 'PHONE', 'outside name');
    await updateDeviceName(f.et, 'alice', 'PHONE', 'renamed outside');
    const authority = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    await f.hj.receive('edge_a', [authority]);
    await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
    const device = await deviceIdentity(f.et, 'alice', 'PHONE');
    await f.et.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: {
              user_id: '@alice:logical.test',
              device_id: 'PHONE',
              algorithms: [],
              keys: { 'ed25519:PHONE': 'public-owner-key' },
              signatures: {},
            },
            one_time_keys: { 'curve25519:secret': 'private-pool-material' },
            fallback_keys: { 'curve25519:secret': 'fallback-pool-material' },
          },
          '@alice:logical.test',
          'PHONE',
          config().e2ee,
        ),
      )
    );
    const reverse = await f.es.export('alice');
    assertEquals(
      JSON.stringify(reverse).includes('private-pool-material'),
      false,
    );
    assertEquals(
      JSON.stringify(reverse).includes('fallback-pool-material'),
      false,
    );
    assert(reverse.length > 0, 'facade public intent must be pulled by home');
    for (const record of reverse) {
      await f.hj.receive('edge_a', [record]);
      assertEquals(await f.hs.apply(f.hj, record, f.bundle.id), true);
    }
    const hdb = await f.home.tenant('logical.test');
    assertEquals(
      (await hdb.tx((conn) => publicDeviceValues(conn, 'alice'))).map((
        op,
      ) => [op.deviceId, op.value?.displayName]),
      [['LAN', 'home name'], ['PHONE', 'renamed outside']],
    );
    assertEquals(
      (await hdb.query('SELECT device_id FROM devices')).map((row) =>
        row.device_id
      ),
      ['LAN'],
    );
    assertEquals(await f.hs.export('alice', f.bundle.id), records);
    assertEquals(
      (await hdb.tx((conn) => publicDeviceValues(conn, 'alice'))).find((op) =>
        op.deviceId === 'PHONE'
      )?.value?.keys?.keys,
      { 'ed25519:PHONE': 'public-owner-key' },
    );
    assertEquals(await f.hs.apply(f.hj, reverse[0], f.bundle.id), false);
  } finally {
    await f.close();
  }
});

Deno.test('device link: reader negotiation does not change F1 required capabilities', () => {
  assertEquals(
    LINK_SUPPORTED.some((cap) =>
      cap.type === 'device-operation' && cap.version === 1
    ),
    true,
  );
  assertEquals(
    LINK_CAPABILITIES.some((cap) => cap.type === 'device-operation'),
    false,
  );
});

Deno.test('signing link: an enrolled home-signed complete identity reaches the tenant before its journal ACK', async () => {
  const f = await fixture();
  try {
    const [template] = await f.hs.export('alice', f.bundle.id);
    const [operation] = await (await f.home.tenant('logical.test')).tx((conn) =>
      captureSigningOperations(conn, 'alice')
    );
    const view = {
      ...(template.payload as { body: DeviceView }).body,
      kind: 'signing-operation',
      operation,
    };
    const body = {
      ...template,
      stream: 'signing:@alice:logical.test',
      type: 'signing-operation',
      operationId: 'signing:' + createHash('sha256').update(canonicalJson([
        f.bundle.id,
        view.grantRevision,
        view.ownerRevision,
        operation.operationId,
      ])).digest('hex'),
      payload: {
        body: view,
        signature: await f.ht.signer().sign(canonicalJson(view)),
      },
    };
    const { hash: _hash, ...unsigned } = body;
    const record = { ...unsigned, hash: recordHash(unsigned) };
    const journal = new Journal(await f.edge.server(), [
      ...LINK_SUPPORTED,
      { type: 'signing-operation', version: 1 },
    ]);
    await journal.receive('home', [record]);
    assertEquals(await f.es.apply(journal, record), true);
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT payload_json FROM signing_operations',
      )).map((row) => JSON.parse(String(row.payload_json))),
      [operation],
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.hash,
      record.hash,
    );
  } finally {
    await f.close();
  }
});

Deno.test('signing link: selected home identity export is stable and own-user scoped, never edge-authored or a mutable device', async () => {
  const f = await fixture();
  const user = '@alice:logical.test';
  try {
    const input = await signingInput();
    await f.ht.tx((tx) =>
      tx.crossSigning.upload('alice', user, input, '{}', false)
    );
    const records = await f.hs.exportSigning('alice', f.bundle.id);
    assertEquals(records.length, 1);
    assertEquals(records[0].type, 'signing-operation');
    assertEquals(records[0].stream, 'signing:@alice:logical.test');
    assertEquals(await f.hs.exportSigning('alice', f.bundle.id), records);
    await f.ej.receive('home', records);
    assertEquals(await f.es.apply(f.ej, records[0]), true);
    assertEquals(await f.es.apply(f.ej, records[0]), false);
    assertEquals(await f.et.tx((tx) => tx.crossSigning.state('alice')), input);
    await assertRejects(
      () => f.et.tx((tx) => tx.crossSigning.views('alice', user, user)),
      MatrixError,
      'key bootstrap unavailable',
    );
    for (const record of await f.hs.bootstrap('alice', f.bundle.id)) {
      await f.ej.receive('home', [record]);
      await f.es.apply(f.ej, record);
    }
    const own = await f.et.tx((tx) =>
      tx.crossSigning.views('alice', user, user)
    );
    const other = await f.et.tx((tx) =>
      tx.crossSigning.views('alice', user, '@bob:logical.test')
    );
    assert(own.user_signing_keys);
    assertEquals(other.user_signing_keys, undefined);
    assertEquals(await f.es.exportSigning('alice'), []);
    assertEquals(
      await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM devices',
      ),
      [],
    );
    assertEquals(
      LINK_SUPPORTED.some((cap) =>
        cap.type === 'signing-operation' && cap.version === 1
      ),
      true,
    );
    assertEquals(
      LINK_CAPABILITIES.some((cap) => cap.type === 'signing-operation'),
      false,
    );
    for (
      const [owner, pairing] of [[f.hs, f.bundle.id], [
        f.es,
        undefined,
      ]] as const
    ) {
      await assertRejects(
        () => owner.exportSigning('bob', pairing),
        Error,
        'account not selected',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('signing link: forged signature, source, account, grant, stream or record kind cannot gain an identity or ACK', async () => {
  for (
    const fault of [
      'signature',
      'source',
      'localpart',
      'grantRevision',
      'stream',
      'type',
    ] as const
  ) {
    const f = await fixture();
    try {
      const [record] = await f.hs.exportSigning('alice', f.bundle.id);
      const signed = record.payload as {
        body: Record<string, unknown>;
        signature: string;
      };
      if (fault === 'signature') signed.signature = 'A'.repeat(86);
      else if (fault === 'stream') {
        record.stream = 'devices:@alice:logical.test';
      } else if (fault === 'type') record.type = 'device-operation';
      else {
        signed.body[fault] = fault === 'source'
          ? 'edge_a'
          : fault === 'localpart'
          ? 'bob'
          : Number(signed.body.grantRevision) + 1;
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      const { hash: _hash, ...body } = record;
      record.hash = recordHash(body);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM signing_operations',
        ),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signing link: tenant control, account selection and live pairing fence identity import', async () => {
  for (const fault of ['control', 'selection', 'revoked'] as const) {
    const f = await fixture();
    try {
      const [record] = await f.hs.exportSigning('alice', f.bundle.id);
      await f.ej.receive('home', [record]);
      const tenant = await f.edge.tenant('logical.test');
      if (fault === 'control') {
        await tenant.tx((conn) =>
          conn.execute('DELETE FROM facade_owner_activation')
        );
      } else if (fault === 'selection') {
        await tenant.tx((conn) =>
          conn.execute(
            'UPDATE account_auth_snapshots SET grant_revision=grant_revision+1',
          )
        );
      } else await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(await tenant.query('SELECT * FROM signing_operations'), []);
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signing link: revocation before or during identity admission rolls back both fact and receipt', async () => {
  for (const cut of ['before', 'during'] as const) {
    const f = await fixture();
    try {
      const [record] = await f.hs.exportSigning('alice', f.bundle.id);
      await f.ej.receive('home', [record]);
      const paused = pauseImport(f.edge, cut);
      const outcome = f.es.apply(f.ej, record).then(
        () => null,
        (error) => error,
      );
      try {
        await paused.reached;
        await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      assert(await outcome instanceof Error);
      const tenant = await f.edge.tenant('logical.test');
      assertEquals(await tenant.query('SELECT * FROM signing_operations'), []);
      assertEquals(
        await tenant.query('SELECT * FROM facade_link_applications'),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signing link: admitted identity survives retirement and ACK loss with exact cold completion only', async () => {
  const f = await fixture();
  try {
    await f.hs.exportSigning('alice', f.bundle.id);
    await f.ht.tx(async (tx) =>
      tx.crossSigning.upload(
        'alice',
        '@alice:logical.test',
        await signingInput(),
        '{}',
        false,
      )
    );
    const records = await f.hs.exportSigning('alice', f.bundle.id);
    assertEquals(records.length, 2);
    await f.ej.receive('home', records);
    const paused = pauseImport(f.edge, 'after');
    f.ej.complete = () =>
      Promise.reject(new Error('injected signing ACK loss'));
    const outcome = f.es.apply(f.ej, records[0]).then(
      () => null,
      (error) => error,
    );
    try {
      await paused.reached;
      await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
    } finally {
      paused.resume();
      paused.restore();
    }
    const error = await outcome;
    assert(
      error instanceof Error && error.message === 'injected signing ACK loss',
    );
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const pairings = new Pairings(
        await reopened.server(),
        f.node.signer(),
        f.node.publicKey,
        'b'.repeat(64),
        f.node,
      );
      const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
      const owner = new DeviceOperations(reopened, f.et, pairings, f.node);
      assertEquals(await owner.apply(journal, records[0]), true);
      assertEquals(
        (await journal.heads('home', 'in', records[0])).applied.hash,
        records[0].hash,
      );
      assertEquals(
        (await (await reopened.tenant('logical.test')).query(
          'SELECT * FROM signing_operations',
        )).length,
        1,
      );
      await assertRejects(() => owner.apply(journal, records[1]), Error);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: missing incarnation cannot ACK and resumes only after authentic authority arrives', async () => {
  const f = await fixture();
  try {
    await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
    const records = await f.es.export('alice');
    assert(records.length > 0);
    await f.hj.receive('edge_a', records);
    await assertRejects(
      () => f.hs.apply(f.hj, records[0], f.bundle.id),
      Error,
      'awaits incarnation',
    );
    assertEquals(
      await (await f.home.tenant('logical.test')).query(
        'SELECT * FROM device_operations',
      ),
      [],
    );
    assertEquals(
      (await f.hj.next('edge_a', records[0]))?.hash,
      records[0].hash,
    );
    const authority = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    await f.hj.receive('edge_a', [authority]);
    await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
    for (const record of records) {
      assertEquals(await f.hs.apply(f.hj, record, f.bundle.id), true);
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: committed owner fact survives ACK loss and cold reopen without duplicate intent', async () => {
  const f = await fixture();
  try {
    const records = await f.hs.export('alice', f.bundle.id);
    assert(records.length > 0);
    await f.ej.receive('home', records);
    const complete = f.ej.complete.bind(f.ej);
    f.ej.complete = () => Promise.reject(new Error('injected ACK loss'));
    await assertRejects(
      () => f.es.apply(f.ej, records[0]),
      Error,
      'injected ACK loss',
    );
    f.ej.complete = complete;
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM device_operations',
      )).length,
      1,
    );
    assertEquals((await f.ej.next('home', records[0]))?.hash, records[0].hash);
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const pairings = new Pairings(
        await reopened.server(),
        f.node.signer(),
        f.node.publicKey,
        'b'.repeat(64),
        f.node,
      );
      const tenant = await enrolledTenant(
        reopened,
        pairings,
        'logical.test',
        'edge_a',
      );
      const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
      const owner = new DeviceOperations(reopened, tenant, pairings, f.node);
      assertEquals(await owner.apply(journal, records[0]), true);
      assertEquals(await owner.apply(journal, records[0]), false);
      assertEquals(
        (await (await reopened.tenant('logical.test')).query(
          'SELECT * FROM device_operations',
        )).length,
        1,
      );
      assertEquals(await owner.export('alice'), []);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: unselected accounts are refused before any export intent', async () => {
  const f = await fixture();
  try {
    for (
      const [owner, pairing] of [[f.hs, f.bundle.id], [
        f.es,
        undefined,
      ]] as const
    ) {
      await assertRejects(
        () => owner.export('bob', pairing),
        Error,
        'account not selected',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: revocation before or during tenant admission rolls back at both receiving owners', async () => {
  for (const side of ['home', 'edge'] as const) {
    for (const cut of ['before', 'during'] as const) {
      const f = await fixture();
      try {
        if (side === 'home') {
          await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
          const auth = await exportSessionAuthority(
            f.edge,
            f.et,
            f.fp,
            f.owners,
            f.node,
            'alice',
          );
          await f.hj.receive('edge_a', [auth]);
          await f.accounts.applyFromFacade(f.hj, f.bundle.id, auth);
        }
        const store = side === 'home' ? f.home : f.edge;
        const owner = side === 'home' ? f.hs : f.es;
        const journal = side === 'home' ? f.hj : f.ej;
        const peer = side === 'home' ? 'edge_a' : 'home';
        const records = side === 'home'
          ? await f.es.export('alice')
          : await f.hs.export('alice', f.bundle.id);
        await journal.receive(peer, records);
        const paused = pauseImport(store, cut);
        const outcome = owner.apply(
          journal,
          records[0],
          side === 'home' ? f.bundle.id : undefined,
        )
          .then(() => null, (error) => error);
        try {
          await paused.reached;
          const revoked = await f.hp.revoke(f.bundle.id);
          if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
        } finally {
          paused.resume();
          paused.restore();
        }
        assert(await outcome instanceof Error, 'revoked admission must refuse');
        assertEquals(
          await (await store.tenant('logical.test')).query(
            'SELECT * FROM device_operations',
          ),
          [],
          cut,
        );
        assertEquals(
          (await journal.next(peer, records[0]))?.hash,
          records[0].hash,
        );
      } finally {
        await f.close();
      }
    }
  }
});

Deno.test('device link: revocation after tenant admission completes its exact ACK after cold reopen only', async () => {
  for (const side of ['edge', 'home'] as const) {
    const f = await fixture();
    try {
      if (side === 'home') {
        await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
        const auth = await exportSessionAuthority(
          f.edge,
          f.et,
          f.fp,
          f.owners,
          f.node,
          'alice',
        );
        await f.hj.receive('edge_a', [auth]);
        await f.accounts.applyFromFacade(f.hj, f.bundle.id, auth);
        await f.es.export('alice');
        await updateDeviceName(f.et, 'alice', 'PHONE', 'second edge fact');
      } else {
        await f.hs.export('alice', f.bundle.id);
        await updateDeviceName(f.ht, 'alice', 'LAN', 'second home fact');
      }
      const store = side === 'home' ? f.home : f.edge;
      const receiver = side === 'home' ? f.hs : f.es;
      const currentJournal = side === 'home' ? f.hj : f.ej;
      const peer = side === 'home' ? 'edge_a' : 'home';
      const pairing = side === 'home' ? f.bundle.id : undefined;
      const records = side === 'home'
        ? await f.es.export('alice')
        : await f.hs.export('alice', f.bundle.id);
      assert(records.length >= 2);
      await currentJournal.receive(peer, records);
      const paused = pauseImport(store, 'after');
      const complete = currentJournal.complete.bind(currentJournal);
      currentJournal.complete = () =>
        Promise.reject(new Error('injected ACK loss'));
      const outcome = receiver.apply(currentJournal, records[0], pairing).then(
        () => null,
        (error) => error,
      );
      try {
        await paused.reached;
        const revoked = await f.hp.revoke(f.bundle.id);
        if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      const error = await outcome;
      assert(
        error instanceof Error && error.message === 'injected ACK loss',
        'already admitted fact must reach durable completion, not a new live-grant check',
      );
      currentJournal.complete = complete;
      assertEquals(
        (await (await store.tenant('logical.test')).query(
          'SELECT * FROM device_operations',
        )).length,
        1,
      );
      await store.close();
      const reopened = await f.open(side);
      try {
        const pairings = side === 'edge'
          ? new Pairings(
            await reopened.server(),
            f.node.signer(),
            f.node.publicKey,
            'b'.repeat(64),
            f.node,
          )
          : new Pairings(
            await reopened.server(),
            f.ht.signer(),
            f.ht.publicB64,
            'a'.repeat(64),
          );
        const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
        const owner = new DeviceOperations(
          reopened,
          side === 'edge' ? f.et : f.ht,
          pairings,
          side === 'edge' ? f.node : undefined,
        );
        assertEquals(await owner.apply(journal, records[0], pairing), true);
        assertEquals((await journal.heads(peer, 'in', records[0])).applied, {
          sequence: records[0].sequence,
          hash: records[0].hash,
        });
        assertEquals(
          (await (await reopened.tenant('logical.test')).query(
            'SELECT * FROM device_operations',
          )).length,
          1,
        );
        // A retained receipt is not permission to admit a second signed record.
        await assertRejects(
          () => owner.apply(journal, records[1], pairing),
          Error,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test('device link: current tenant control, selection and live server grant fence every import', async () => {
  for (const fault of ['control', 'selection', 'revoked'] as const) {
    const f = await fixture();
    try {
      const records = await f.hs.export('alice', f.bundle.id);
      assert(records.length > 0);
      await f.ej.receive('home', records);
      const tenant = await f.edge.tenant('logical.test');
      if (fault === 'control') {
        await tenant.tx((conn) =>
          conn.execute('DELETE FROM facade_owner_activation')
        );
      } else if (fault === 'selection') {
        await tenant.tx((conn) =>
          conn.execute(
            'UPDATE account_auth_snapshots SET grant_revision=grant_revision+1',
          )
        );
      } else {await (await f.edge.server()).tx((conn) =>
          conn.execute("UPDATE facade_pairings SET state='revoked'")
        );}
      await assertRejects(() => f.es.apply(f.ej, records[0]), Error);
      assertEquals(await tenant.query('SELECT * FROM device_operations'), []);
      assertEquals(
        (await f.ej.next('home', records[0]))?.hash,
        records[0].hash,
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('device link: forged signature, source, account, grant and stream never mutate the tenant or advance apply', async () => {
  const variants = [
    'signature',
    'source',
    'localpart',
    'grantRevision',
    'stream',
  ] as const;
  for (const variant of variants) {
    const f = await fixture();
    try {
      const records = await f.hs.export('alice', f.bundle.id);
      assert(records.length > 0, 'device source intent is required');
      const record = structuredClone(records[0]);
      const signed = record.payload as {
        body: Record<string, unknown>;
        signature: string;
      };
      if (variant === 'signature') signed.signature = 'A'.repeat(86);
      else if (variant === 'stream') {
        record.stream = 'devices:@bob:logical.test';
      } else {
        signed.body[variant] = variant === 'source'
          ? 'edge_a'
          : variant === 'localpart'
          ? 'bob'
          : Number(signed.body.grantRevision) + 1;
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      const { hash: _hash, ...body } = record;
      record.hash = recordHash(body);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM device_operations',
        ),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});
