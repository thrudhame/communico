import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { closeApp, openApp } from '#engine/app.ts';
import { loadConfig, loadedConfig, setConfigForTests } from '#engine/config.ts';
import { createBackup } from '#engine/backup/bundle.ts';
import { restoreBackup } from '#engine/backup/restore.ts';
import { describePayload, readManifest } from '#engine/backup/manifest.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { keyStatus, uploadKeys, validateUpload } from '#engine/tenant/e2ee.ts';
import { recoveryState } from '#engine/server/recovery.ts';
import { createRoom } from '#engine/room/create.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

async function fixture(encrypted = false) {
  const root = await Deno.makeTempDir({ prefix: "restore's-control-" });
  const settings = loadedConfig();
  const cfg = {
    ...structuredClone(settings.config),
    store: {
      ...settings.config.store,
      dir: join(root, 'source'),
      library: './.native/libturso_ffi.so',
    },
    media: { ...settings.config.media, root: join(root, 'source-media') },
    backup: {
      encrypt: encrypted,
      passphrasefile: encrypted ? join(root, 'passphrase') : '',
    },
    federation: {
      ...settings.config.federation,
      enabled: false,
      cert: 'tests/fixtures/tls/localhost.crt',
      key: 'tests/fixtures/tls/localhost.key',
      cacerts: ['tests/fixtures/tls/ca.crt'],
    },
  };
  if (encrypted) {
    await Deno.writeTextFile(
      cfg.backup.passphrasefile,
      'restore passphrase\n',
      { mode: 0o600 },
    );
  }
  await Deno.mkdir(cfg.media.root);
  setConfigForTests(cfg);
  const app = await openApp(cfg.store);
  const user = await registerUser(app.tenant, {
    localpart: 'alice',
    password: 'pw',
    deviceId: 'PHONE',
  });
  const device = await deviceIdentity(app.tenant, 'alice', 'PHONE');
  await (await app.store.tenant(app.tenant.serverName)).tx((tx) =>
    uploadKeys(
      tx,
      device,
      validateUpload(
        {
          one_time_keys: { 'curve25519:once': 'old' },
          fallback_keys: { 'curve25519:old': 'old fallback' },
        },
        user.user_id,
        'PHONE',
        cfg.e2ee,
      ),
    )
  );
  const room = await createRoom(app.store, {
    creator: user.user_id,
    preset: 'private_chat',
  }, app.tenant.signer());
  await app.tenant.tx((tx) =>
    tx.media.insert('alice', 'attachment', 'uploaded', { size_bytes: 10 })
  );
  await Deno.writeTextFile(join(cfg.media.root, 'attachment'), 'ciphertext');
  const sourceSettings = { ...settings, config: cfg, configPath: null };
  const bundle = join(root, 'bundle');
  await createBackup(app.store, bundle, sourceSettings);
  const manifest = await readManifest(bundle);
  await closeApp();
  const targetSettings = {
    ...sourceSettings,
    config: {
      ...structuredClone(cfg),
      store: { ...cfg.store, dir: join(root, 'target') },
      media: { ...cfg.media, root: join(root, 'target-media') },
    },
  };
  const archiveDigests = await Promise.all(
    manifest.payloads.map((payload) =>
      describePayload(bundle, payload.stored.path)
    ),
  );
  return {
    root,
    cfg,
    bundle,
    manifest,
    archiveDigests,
    targetSettings,
    user,
    device,
    room,
    close: async () => {
      await closeApp();
      setConfigForTests({});
      await Deno.remove(root, { recursive: true });
    },
  };
}

for (const encrypted of [false, true]) {
  Deno.test(
    'offline restore: ' + (encrypted ? 'OpenPGP' : 'plaintext') +
      ' control preserves identity, room truth, credentials and media while sanitizing a private candidate and binding its report',
    async () => {
      const f = await fixture(encrypted);
      try {
        const result = await restoreBackup(f.bundle, {}, f.targetSettings);
        assertEquals(result.path, f.targetSettings.config.store.dir);
        assertEquals(result.report.backupId, f.manifest.backupId);
        assertEquals(result.report.format, 1);
        assertEquals((await Deno.stat(result.reportPath)).mode! & 0o777, 0o600);
        assertEquals(
          await Deno.readTextFile(join(result.media, 'attachment')),
          'ciphertext',
        );
        const restored = loadConfig({
          defaultsPath: f.targetSettings.defaultsPath,
          configPath: result.configPath,
          env: {},
        });
        assertEquals(restored.config.server.name, f.manifest.serverName);
        assertEquals(restored.config.store.dir, result.path);
        assertEquals(restored.config.media.root, result.media);
        assertEquals(
          restored.config.federation.cert,
          join(result.path, 'deployment', 'federation-cert.pem'),
        );
        assertEquals(
          restored.config.federation.key,
          join(result.path, 'deployment', 'federation-key.pem'),
        );
        assertEquals(restored.config.federation.cacerts, [
          join(result.path, 'deployment', 'federation-ca-0.pem'),
        ]);
        assertEquals(
          await Deno.readTextFile(restored.config.federation.cert),
          await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
        );
        setConfigForTests(restored.config);
        const app = await openApp(restored.config.store);
        assertEquals(app.tenant.keyId, f.manifest.tenants[0].keyId);
        assertEquals(app.tenant.publicB64, f.manifest.tenants[0].publicKey);
        const db = await app.store.tenant(app.tenant.serverName);
        assertEquals(
          (await db.query('SELECT COUNT(*) AS n FROM access_tokens'))[0].n,
          1,
        );
        assertEquals((await db.tx((tx) => keyStatus(tx, f.device))).counts, {});
        assertEquals((await db.tx((tx) => keyStatus(tx, f.device))).unused, []);
        assert(
          (await (await app.store.room(f.room.roomId)).query(
            'SELECT id FROM events',
          )).length > 0,
        );
        assertEquals(
          (await recoveryState(app.server))?.epoch,
          result.report.epoch,
        );
        assertEquals(
          await Promise.all(
            f.manifest.payloads.map((payload) =>
              describePayload(f.bundle, payload.stored.path)
            ),
          ),
          f.archiveDigests,
        );
        await assertRejects(
          () => restoreBackup(f.bundle, { replace: true }, f.targetSettings),
          Error,
          'owned',
        );
      } finally {
        await f.close();
      }
    },
  );
}

Deno.test('offline restore: nonempty targets require explicit replacement and keep the complete prior pair; archive overlap and wrong passphrase leave prior data intact', async () => {
  const f = await fixture(true);
  try {
    for (
      const path of [
        f.targetSettings.config.store.dir,
        f.targetSettings.config.media.root,
      ]
    ) {
      await Deno.mkdir(path);
      await Deno.writeTextFile(join(path, 'prior'), 'do not discard');
    }
    await assertRejects(
      () => restoreBackup(f.bundle, {}, f.targetSettings),
      Error,
      'nonempty',
    );
    await Deno.writeTextFile(f.cfg.backup.passphrasefile, 'wrong\n', {
      mode: 0o600,
    });
    await assertRejects(
      () => restoreBackup(f.bundle, { replace: true }, f.targetSettings),
      Error,
      'OpenPGP',
    );
    assertEquals(
      await Deno.readTextFile(join(f.targetSettings.config.store.dir, 'prior')),
      'do not discard',
    );
    assertEquals(
      await Deno.readTextFile(
        join(f.targetSettings.config.media.root, 'prior'),
      ),
      'do not discard',
    );
    await Deno.writeTextFile(
      f.cfg.backup.passphrasefile,
      'restore passphrase\n',
      { mode: 0o600 },
    );
    const result = await restoreBackup(
      f.bundle,
      { replace: true },
      f.targetSettings,
    );
    assertEquals(
      await Deno.readTextFile(join(result.replaced.store!, 'prior')),
      'do not discard',
    );
    assertEquals(
      await Deno.readTextFile(join(result.replaced.media!, 'prior')),
      'do not discard',
    );
    await assertRejects(
      () =>
        restoreBackup(f.bundle, { replace: true }, {
          ...f.targetSettings,
          config: {
            ...f.targetSettings.config,
            store: {
              ...f.targetSettings.config.store,
              dir: join(f.bundle, 'bad'),
            },
          },
        }),
      Error,
      'overlap',
    );
    const before = await Deno.readTextFile(result.reportPath);
    // Pure storage reopen cannot run an app worker or bypass its report gate.
    const raw = await openStore(f.targetSettings.config.store, {
      schemas: { room: roomSchema, tenant: tenantSchema, server: serverSchema },
    });
    await raw.close();
    assertEquals(await Deno.readTextFile(result.reportPath), before);
  } finally {
    await f.close();
  }
});

Deno.test('offline restore: target overrides preserve the Matrix name and never serialize independently supplied environment secrets', async () => {
  const f = await fixture();
  try {
    const target = {
      ...f.targetSettings,
      sources: {
        ...f.targetSettings.sources,
        'server.port': 'env' as const,
        'turn.secret': 'env' as const,
      },
      config: {
        ...f.targetSettings.config,
        server: { ...f.targetSettings.config.server, port: 18999 },
        turn: { ...f.targetSettings.config.turn, secret: 'do-not-serialize' },
      },
    };
    const result = await restoreBackup(f.bundle, {}, target);
    const text = await Deno.readTextFile(result.configPath);
    assert(!text.includes('do-not-serialize'));
    assert(
      result.report.warnings.some((warning) =>
        warning.includes('COMMUNICO_TURN_SECRET')
      ),
    );
    const restored = loadConfig({
      defaultsPath: target.defaultsPath,
      configPath: result.configPath,
      env: {},
    });
    assertEquals(restored.config.server.port, 18999);
    assertEquals(restored.config.server.name, f.manifest.serverName);
    const mismatch = {
      ...target,
      sources: { ...target.sources, 'server.name': 'config' as const },
      config: {
        ...target.config,
        server: { ...target.config.server, name: 'wrong.test' },
      },
    };
    await assertRejects(
      () => restoreBackup(f.bundle, { replace: true }, mismatch),
      Error,
      'logical server identity',
    );
    assertEquals(
      await Deno.readTextFile(result.reportPath),
      JSON.stringify(result.report, null, 2) + '\n',
    );
  } finally {
    await f.close();
  }
});
