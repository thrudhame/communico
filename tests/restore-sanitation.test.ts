import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { openStore } from '#engine/store/index.ts';
import { copyPrivate } from '#engine/store/files.ts';
import {
  type CandidateStore,
  withCandidateStore,
} from '#engine/store/candidate.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import {
  claimKey,
  keyStatus,
  uploadKeys,
  validateUpload,
} from '#engine/tenant/e2ee.ts';
import { config } from '#engine/config.ts';
import { sanitizeRestoredTenant } from '#engine/tenant/restore.ts';
import {
  acknowledge as acknowledgeMessages,
  deliverMessages,
  insertMessage,
} from '#engine/tenant/todevice.ts';
import { onStartup } from '#engine/store/watermark.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { accountSession } from '#engine/tenant/backup-accounting.ts';
import { beginPosition } from '#engine/tenant/sliding-sync.ts';
import { MatrixError } from '#engine/matrix-error.ts';

function storage(dir: string) {
  return {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
}

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'restore-sanitation-' });
  const settings = storage(join(root, 'live'));
  const store = await openStore(settings, {
    schemas: { tenant: tenantSchema },
  });
  const tenant = await openTenant(store, 'restore.test', { create: true });
  const user = await registerUser(tenant, {
    localpart: 'alice',
    password: 'pw',
    deviceId: 'PHONE',
  });
  const device = await deviceIdentity(tenant, 'alice', 'PHONE');
  const raw = await store.tenant(tenant.serverName);
  const limits = config().e2ee;
  await raw.tx(async (conn) => {
    await uploadKeys(
      conn,
      device,
      validateUpload(
        {
          device_keys: {
            user_id: user.user_id,
            device_id: 'PHONE',
            algorithms: [],
            keys: {},
            signatures: {},
          },
          one_time_keys: { 'curve25519:once': 'once' },
          fallback_keys: { 'curve25519:stale': 'stale fallback' },
        },
        user.user_id,
        'PHONE',
        limits,
      ),
    );
    await insertMessage(conn, device, 'pending-key', {
      type: 'm.room_key',
      content: { session_id: 'retained' },
    }, limits);
    await conn.execute(
      'INSERT INTO sliding_sync_connections VALUES(?,?,?,?,?,?,?)',
      [
        'connection',
        'alice',
        'PHONE',
        device.generation,
        'lists',
        1,
        Date.now() + 60000,
      ],
    );
    await conn.execute('INSERT INTO sliding_sync_positions VALUES(?,?,?)', [
      'position',
      'connection',
      '{}',
    ]);
    await conn.execute(
      'INSERT INTO backup_versions(localpart,version_no,algorithm,auth_data,etag,deleted) VALUES(?,?,?,?,?,?)',
      ['alice', 1, 'm.megolm_backup.v1.curve25519-aes-sha2', '{}', 1, 0],
    );
    const payload = '{"ciphertext":"retained encrypted backup"}';
    await conn.execute('INSERT INTO backup_sessions VALUES(?,?,?,?,?)', [
      'alice',
      1,
      '!r:restore.test',
      'session',
      payload,
    ]);
    await accountSession(
      conn,
      'alice',
      1,
      '!r:restore.test',
      'session',
      payload,
    );
    await conn.execute('INSERT INTO cross_signing_keys VALUES(?,?,?,?,?)', [
      'alice',
      'master',
      'master',
      '{"public":"retained"}',
      1,
    ]);
    await conn.execute('INSERT INTO key_signatures VALUES(?,?,?,?,?,?,?,?)', [
      'alice',
      user.user_id,
      'master',
      'master',
      user.user_id,
      'PHONE',
      '{}',
      'retained signature',
    ]);
  });
  const oldToken = (await raw.tx((conn) =>
    deliverMessages(conn, device, {
      eSeq: 1,
      pSeq: 0,
      tSeq: 0,
      rSeq: 0,
      aSeq: 0,
      dSeq: 0,
      mSeq: 0,
      kSeq: 0,
    }, limits)
  )).token;
  const cut = await store.snapshot(join(root, 'archive'));
  await store.close();
  await copyPrivate(join(root, 'archive'), join(root, 'candidate'));
  const before = await Promise.all(
    cut.files.map((file) => describePayload(join(root, 'archive'), file.path)),
  );
  return {
    root,
    settings,
    cut,
    device,
    limits,
    oldToken,
    before,
    close: () => Deno.remove(root, { recursive: true }),
  };
}

Deno.test('restore sanitation: purge consuming pools and old delivery authority, retain public keys, crypto backups, inbox and credentials', async () => {
  const f = await fixture();
  try {
    let startupCalls = 0;
    onStartup(() => {
      startupCalls++;
      return Promise.resolve();
    });
    await withCandidateStore(
      f.settings,
      join(f.root, 'candidate'),
      f.cut.files,
      { tenant: tenantSchema },
      async (candidate) => {
        const file = candidate.files.find((file) => file.kind === 'tenants')!;
        const before = await candidate.read(
          file,
          (db) => db.query('SELECT seq FROM key_pool_updates'),
        );
        const result = await candidate.tx(file, sanitizeRestoredTenant);
        assertEquals(result, {
          oneTimeKeys: 1,
          fallbackKeys: 1,
          poolDevices: 1,
          inboxReceipts: 1,
          slidingConnections: 1,
          slidingPositions: 1,
        });
        await candidate.tx(file, async (conn) => {
          const status = await keyStatus(conn, f.device);
          assertEquals(status.counts, {});
          assertEquals(status.unused, []);
          assert(status.seq > Number(before[0].seq));
          assertEquals(
            await claimKey(conn, 'alice', 'PHONE', 'curve25519'),
            null,
          );
          // A genuinely previously-issued receipt cannot consume the restored key.
          await acknowledgeMessages(conn, f.device, f.oldToken);
          assertEquals(
            (await deliverMessages(conn, f.device, f.oldToken, f.limits)).events
              .length,
            1,
          );
          for (
            const table of [
              'device_keys',
              'cross_signing_keys',
              'key_signatures',
              'backup_versions',
              'backup_sessions',
              'access_tokens',
              'credentials',
              'to_device_inbox',
            ]
          ) {
            const [{ n }] = await conn.query(
              `SELECT COUNT(*) AS n FROM ${table}`,
            );
            assertEquals(n, 1, table + ' must be retained');
          }
          assertEquals(
            await conn.query('SELECT * FROM sliding_sync_connections'),
            [],
          );
          assertEquals(
            await conn.query('SELECT * FROM sliding_sync_positions'),
            [],
          );
          const unknown = await assertRejects(() =>
            beginPosition(
              conn,
              f.device,
              'lists',
              'position',
              config().slidingsync,
              Date.now(),
            ), MatrixError);
          assertEquals(unknown.errcode, 'M_UNKNOWN_POS');
          await uploadKeys(
            conn,
            f.device,
            validateUpload(
              {
                one_time_keys: { 'curve25519:fresh': 'fresh' },
                fallback_keys: { 'curve25519:fresh': 'fresh fallback' },
              },
              '@alice:restore.test',
              'PHONE',
              f.limits,
            ),
          );
          assertEquals(await claimKey(conn, 'alice', 'PHONE', 'curve25519'), {
            'curve25519:fresh': 'fresh',
          });
        });
      },
    );
    assertEquals(startupCalls, 0);
    assertEquals(
      await Promise.all(
        f.cut.files.map((file) =>
          describePayload(join(f.root, 'archive'), file.path)
        ),
      ),
      f.before,
    );
  } finally {
    await f.close();
  }
});

Deno.test('restore sanitation: consuming pools are fully purged across keyset batches and a repeated sanitation is harmless', async () => {
  const f = await fixture();
  try {
    await withCandidateStore(
      f.settings,
      join(f.root, 'candidate'),
      f.cut.files,
      { tenant: tenantSchema },
      async (candidate) => {
        const file = candidate.files.find((file) => file.kind === 'tenants')!;
        await candidate.tx(file, async (conn) => {
          for (let n = 0; n < 257; n++) {
            await conn.execute('INSERT INTO devices VALUES(?,?,?,?)', [
              'EXTRA' + n,
              'alice',
              1,
              null,
            ]);
            await conn.execute(
              'INSERT INTO one_time_keys VALUES(?,?,?,?,?,?,?)',
              ['alice', 'EXTRA' + n, 1, 'curve25519', 'once', 1, '"once"'],
            );
          }
          const result = await sanitizeRestoredTenant(conn);
          assertEquals(result.oneTimeKeys, 258);
          assertEquals(result.fallbackKeys, 1);
          assertEquals(result.poolDevices, 258);
          assertEquals(await conn.query('SELECT * FROM one_time_keys'), []);
          assertEquals(await conn.query('SELECT * FROM fallback_keys'), []);
          assertEquals(await sanitizeRestoredTenant(conn), {
            oneTimeKeys: 0,
            fallbackKeys: 0,
            poolDevices: 0,
            inboxReceipts: 0,
            slidingConnections: 0,
            slidingPositions: 0,
          });
        });
      },
    );
  } finally {
    await f.close();
  }
});

Deno.test('restore sanitation: transaction failure rolls back pools and invalidation receipts together', async () => {
  const f = await fixture();
  try {
    await withCandidateStore(
      f.settings,
      join(f.root, 'candidate'),
      f.cut.files,
      { tenant: tenantSchema },
      async (candidate) => {
        const file = candidate.files.find((file) => file.kind === 'tenants')!;
        await assertRejects(
          () =>
            candidate.tx(file, async (conn) => {
              await sanitizeRestoredTenant(conn);
              throw new Error('candidate failure');
            }),
          Error,
          'candidate failure',
        );
        await candidate.read(file, async (db) => {
          assertEquals(
            (await db.query('SELECT COUNT(*) AS n FROM one_time_keys'))[0].n,
            1,
          );
          assertEquals(
            (await db.query('SELECT COUNT(*) AS n FROM fallback_keys'))[0].n,
            1,
          );
          assertEquals(
            (await db.query('SELECT COUNT(*) AS n FROM sync_deliveries'))[0].n,
            1,
          );
          assertEquals(
            (await db.query(
              'SELECT COUNT(*) AS n FROM sliding_sync_positions',
            ))[0].n,
            1,
          );
        });
      },
    );
  } finally {
    await f.close();
  }
});

Deno.test('restore candidate: only the private candidate migrates, writable capabilities expire, and file identity is checked before mutation', async () => {
  const root = await Deno.makeTempDir({ prefix: 'restore-migration-' });
  const settings = storage(join(root, 'live'));
  const old = {
    version: 1,
    apply: (db: { exec(sql: string): Promise<void> }) =>
      db.exec('CREATE TABLE truth(n INTEGER PRIMARY KEY)'),
  };
  try {
    const store = await openStore(settings, { schemas: { server: old } });
    await (await store.server()).execute('INSERT INTO truth VALUES(1)');
    const cut = await store.snapshot(join(root, 'archive'));
    await store.close();
    await copyPrivate(join(root, 'archive'), join(root, 'candidate'));
    const before = await describePayload(
      join(root, 'archive'),
      'server/data.db',
    );
    let leaked!: CandidateStore;
    const current = {
      ...old,
      version: 2,
      migrations: {
        1: (conn: { exec(sql: string): Promise<void> }) =>
          conn.exec('ALTER TABLE truth ADD COLUMN restored TEXT'),
      },
    };
    await withCandidateStore(settings, join(root, 'candidate'), cut.files, {
      server: current,
    }, async (candidate) => {
      leaked = candidate;
      assertEquals(candidate.files[0].schemaVersion, 1);
      assertEquals(candidate.files[0].migratedTo, 2);
      await candidate.tx(
        candidate.files[0],
        (conn) =>
          conn.execute("UPDATE truth SET restored='yes'").then(() => {}),
      );
      assertEquals(
        await candidate.read(
          candidate.files[0],
          (db) => db.query('SELECT * FROM truth'),
        ),
        [{ n: 1, restored: 'yes' }],
      );
    });
    await assertRejects(
      () => leaked.tx(leaked.files[0], async () => {}),
      Error,
      'closed',
    );
    assertEquals(
      await describePayload(join(root, 'archive'), 'server/data.db'),
      before,
    );
    await assertRejects(
      () =>
        withCandidateStore(settings, join(root, 'candidate'), cut.files, {
          server: old,
        }, async () => {}),
      Error,
      'schema version mismatch',
    );
    await assertRejects(
      () =>
        withCandidateStore(
          settings,
          join(root, 'candidate'),
          [...cut.files, ...cut.files],
          { server: current },
          async () => {},
        ),
      Error,
      'identity/path',
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
