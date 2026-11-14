import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { parse } from '@std/toml';
import { closeApp, openApp } from '#engine/app.ts';
import { loadConfig, loadedConfig, setConfigForTests } from '#engine/config.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { createBackup } from '#engine/backup/bundle.ts';
import { readManifest } from '#engine/backup/manifest.ts';
import { openCipher } from '#engine/backup/encryption.ts';

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'bundle-' });
  const store = {
    dir: join(root, 'store'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  await Deno.mkdir(join(root, 'media'));
  setConfigForTests({ media: { root: join(root, 'media') } });
  const app = await openApp(store);
  const inactive = await openTenant(app.store, 'inactive.test', {
    create: true,
  });
  await inactive.tx(async (tx) => {
    await tx.users.insert('u', 'User');
    await tx.media.insert('u', 'uploaded', 'uploaded', { size_bytes: 3 });
    await tx.media.insert('u', 'reserved', 'pending', {});
  });
  for (const id of ['uploaded', 'reserved', 'orphan']) {
    await Deno.writeTextFile(join(root, 'media', id), 'abc');
  }
  const overlay = join(root, "operator's.toml");
  await Deno.writeTextFile(
    overlay,
    '[server]\nname="localhost"\n[federation]\nenabled=false\n',
  );
  const env = {
    COMMUNICO_TURN_SECRET: 'external-secret-never-archive',
    COMMUNICO_SERVER_PORT: '8123',
  };
  const loaded = loadConfig({
    defaultsPath: loadedConfig().defaultsPath,
    configPath: overlay,
    env,
  });
  const settings = {
    ...loadedConfig(),
    ...loaded,
    configPath: overlay,
    config: {
      ...loaded.config,
      store,
      media: { ...loaded.config.media, root: join(root, 'media') },
    },
  };
  return {
    root,
    app,
    settings,
    close: async () => {
      await closeApp();
      setConfigForTests({});
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test('backup bundle: exact running-store bundle includes immutable local media and portable deployment but no runtime/cache/environment secrets', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, "operator's-backup");
    const result = await createBackup(f.app.store, path, f.settings);
    const manifest = await readManifest(path);
    assertEquals(manifest, result.manifest);
    assertEquals(manifest.tenants.length, 2);
    assertEquals(manifest.media, [{
      tenant: 'inactive.test',
      id: 'uploaded',
      path: 'media/uploaded',
    }]);
    assertEquals(await Deno.readTextFile(join(path, 'media/uploaded')), 'abc');
    assertEquals(manifest.configuration.externalSecrets, [
      'COMMUNICO_TURN_SECRET',
    ]);
    const effective = manifest.deployment.find((d) =>
      d.node === 'config.effective'
    )!;
    const config = parse(await Deno.readTextFile(join(path, effective.path)));
    assertEquals((config.server as Record<string, unknown>).port, 8123);
    assertEquals((config.turn as Record<string, unknown>).secret, undefined);
    assertEquals((config.backup as Record<string, unknown>).passphrasefile, '');
    assertEquals(
      await Deno.readTextFile(join(path, manifest.configuration.overlay!)),
      await Deno.readTextFile(f.settings.configPath!),
    );
    for (
      const file of [
        'manifest.json',
        ...manifest.payloads.map((p) => p.stored.path),
      ]
    ) assertEquals((await Deno.stat(join(path, file))).mode! & 0o777, 0o600);
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o700);
    assertEquals(
      [...Deno.readDirSync(f.root)].filter((e) =>
        e.name.startsWith('.communico-backup-')
      ),
      [],
    );
    assert(manifest.cut.pauseMs >= 0);
    await (await f.app.store.server()).query('SELECT 1');
    await assertRejects(() => createBackup(f.app.store, path, f.settings));
    assertEquals(await readManifest(path), manifest);
  } finally {
    await f.close();
  }
});

Deno.test('backup bundle: live-root overlap, symlink payloads and missing uploaded bytes refuse without publishing a bundle', async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () =>
        createBackup(f.app.store, join(f.root, 'store', 'backup'), f.settings),
      Error,
      'overlap',
    );
    await assertRejects(
      () =>
        createBackup(f.app.store, join(f.root, 'media', 'backup'), f.settings),
      Error,
      'overlap',
    );
    await Deno.remove(join(f.root, 'media', 'uploaded'));
    const path = join(f.root, 'refused');
    await assertRejects(() => createBackup(f.app.store, path, f.settings));
    await assertRejects(() => Deno.lstat(path), Deno.errors.NotFound);
    await Deno.symlink(
      join(f.root, 'media', 'orphan'),
      join(f.root, 'media', 'uploaded'),
    );
    await assertRejects(() => createBackup(f.app.store, path, f.settings));
    assertEquals(
      [...Deno.readDirSync(f.root)].filter((e) =>
        e.name.startsWith('.communico-backup-')
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('backup bundle: optional OpenPGP removes own plaintext staging, never archives passphrase and preserves the source', async () => {
  const f = await fixture();
  try {
    const passphrase = join(f.root, 'passphrase');
    await Deno.writeTextFile(passphrase, 'test backup passphrase\n', {
      mode: 0o600,
    });
    f.settings.config.backup = { encrypt: true, passphrasefile: passphrase };
    const result = await createBackup(
      f.app.store,
      join(f.root, 'encrypted'),
      f.settings,
    );
    assertEquals(result.manifest.encryption, 'openpgp-aes256');
    for (const payload of result.manifest.payloads) {
      assert(payload.stored.path.endsWith('.gpg'));
      await assertRejects(
        () => Deno.lstat(join(result.path, payload.path)),
        Deno.errors.NotFound,
      );
    }
    assertEquals(
      await Deno.readTextFile(passphrase),
      'test backup passphrase\n',
    );
    await readManifest(result.path);
  } finally {
    await f.close();
  }
});

Deno.test('backup bundle: TLS and CA references have portable mappings; excluded passphrase cannot alias a deployment file', async () => {
  const f = await fixture();
  try {
    const cert = join(f.root, 'server.crt'),
      key = join(f.root, 'server.key'),
      ca = join(f.root, 'authority.pem');
    await Deno.writeTextFile(cert, 'certificate');
    await Deno.writeTextFile(key, 'private deployment key', { mode: 0o600 });
    await Deno.writeTextFile(ca, 'authority');
    const pairing = join(f.root, 'pairing.json');
    await Deno.writeTextFile(pairing, '{"fixture":"protected bootstrap"}', {
      mode: 0o600,
    });
    f.settings.config.federation = {
      ...f.settings.config.federation,
      enabled: true,
      cert,
      key,
      cacerts: [ca],
    };
    f.settings.config.push = { ...f.settings.config.push, cacerts: [ca] };
    f.settings.config.facade = {
      ...f.settings.config.facade,
      linkcert: cert,
      linkkey: key,
      linkcacerts: [ca],
      pairfile: pairing,
    };
    const result = await createBackup(
      f.app.store,
      join(f.root, 'deployment-backup'),
      f.settings,
    );
    for (
      const node of [
        'federation.cert',
        'federation.key',
        'federation.cacerts.0',
        'push.cacerts.0',
        'facade.linkcert',
        'facade.linkkey',
        'facade.linkcacerts.0',
        'facade.pairfile',
      ]
    ) {
      const file = result.manifest.deployment.find((d) => d.node === node)!;
      assert(file.path.startsWith('deployment/'));
      assertEquals(
        await Deno.readTextFile(join(result.path, file.path)),
        await Deno.readTextFile(file.source),
      );
    }
    f.settings.config.facade = {
      ...f.settings.config.facade,
      pairfile: join(f.root, 'already-consumed-pairing.json'),
    };
    const consumed = await createBackup(
      f.app.store,
      join(f.root, 'consumed-bootstrap'),
      f.settings,
    );
    assert(
      !consumed.manifest.deployment.some((file) =>
        file.node === 'facade.pairfile'
      ),
    );
    for (const leaf of ['linkkey', 'pairfile'] as const) {
      f.settings.config.facade = {
        ...f.settings.config.facade,
        [leaf]: leaf === 'linkkey' ? key : pairing,
      };
      await Deno.chmod(leaf === 'linkkey' ? key : pairing, 0o644);
      await assertRejects(
        () =>
          createBackup(
            f.app.store,
            join(f.root, 'unprotected-' + leaf),
            f.settings,
          ),
        Error,
        'private and owned',
      );
      await Deno.chmod(leaf === 'linkkey' ? key : pairing, 0o600);
    }
    f.settings.config.backup = { encrypt: false, passphrasefile: key };
    await assertRejects(
      () =>
        createBackup(f.app.store, join(f.root, 'passphrase-alias'), f.settings),
      Error,
      'excluded passphrase',
    );
    await assertRejects(
      () => Deno.lstat(join(f.root, 'passphrase-alias')),
      Deno.errors.NotFound,
    );
  } finally {
    await f.close();
  }
});

Deno.test('backup bundle: passphrase exclusion retains the captured identity after its pathname is replaced', async () => {
  const f = await fixture();
  const makeTempDir = Deno.makeTempDir;
  try {
    const passphrase = join(f.root, 'captured-passphrase');
    const alias = join(f.root, 'deployment-alias');
    await Deno.writeTextFile(passphrase, 'original private passphrase\n', {
      mode: 0o600,
    });
    await Deno.link(passphrase, alias);
    f.settings.config.backup = { encrypt: true, passphrasefile: passphrase };
    f.settings.config.federation = {
      ...f.settings.config.federation,
      key: alias,
    };
    f.settings.sources['federation.key'] = 'config';
    let replaced = false;
    Deno.makeTempDir = async (options) => {
      const path = await makeTempDir(options);
      if (!replaced && options?.prefix === '.gpg-') {
        replaced = true;
        await Deno.rename(passphrase, join(f.root, 'retained-passphrase'));
        await Deno.writeTextFile(passphrase, 'replacement source\n', {
          mode: 0o600,
        });
      }
      return path;
    };
    await assertRejects(
      () => createBackup(f.app.store, join(f.root, 'race-bundle'), f.settings),
      Error,
      'excluded passphrase',
    );
    assert(replaced, 'the source pathname replacement must actually occur');
  } finally {
    Deno.makeTempDir = makeTempDir;
    await f.close();
  }
});

Deno.test('backup bundle: a deployment-path replacement cannot copy the actual passphrase source', async () => {
  const f = await fixture();
  const lstat = Deno.lstat;
  let reader: Awaited<ReturnType<typeof openCipher>> = null;
  try {
    const passphrase = join(f.root, 'input-passphrase');
    const expectedPassphrase = join(f.root, 'expected-passphrase');
    const key = join(f.root, 'deployment-key');
    await Deno.writeTextFile(passphrase, 'test-private-passphrase\n', {
      mode: 0o600,
    });
    await Deno.writeTextFile(expectedPassphrase, 'test-private-passphrase\n', {
      mode: 0o600,
    });
    await Deno.writeTextFile(key, 'deployment key, not a passphrase', {
      mode: 0o600,
    });
    f.settings.config.backup = { encrypt: true, passphrasefile: passphrase };
    f.settings.config.federation = { ...f.settings.config.federation, key };
    f.settings.sources['federation.key'] = 'config';
    let replaced = false;
    Deno.lstat = async (path) => {
      const stat = await lstat(path);
      if (!replaced && path === key) {
        replaced = true;
        await Deno.rename(key, join(f.root, 'original-deployment-key'));
        await Deno.rename(passphrase, key);
      }
      return stat;
    };
    const backup = await createBackup(
      f.app.store,
      join(f.root, 'deployment-race'),
      f.settings,
    );
    Deno.lstat = lstat;
    assert(replaced, 'the deployment entry replacement must actually occur');
    const file = backup.manifest.deployment.find((file) =>
      file.node === 'federation.key'
    )!;
    const payload = backup.manifest.payloads.find((payload) =>
      payload.path === file.path
    )!;
    const candidate = join(f.root, 'decrypted');
    await Deno.mkdir(join(candidate, 'deployment'), { recursive: true });
    reader = await openCipher({
      encrypt: true,
      passphrasefile: expectedPassphrase,
    }, f.root);
    assert(reader);
    await reader.decrypt(backup.path, payload, candidate);
    assertEquals(
      await Deno.readTextFile(join(candidate, file.path)),
      'deployment key, not a passphrase',
    );
  } finally {
    Deno.lstat = lstat;
    await reader?.close();
    await f.close();
  }
});
