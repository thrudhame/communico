import { assert, assertEquals, assertRejects } from '@std/assert';
import { openCipher } from '#engine/backup/encryption.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { loadConfig } from '#engine/config.ts';

async function fixture(
  fn: (root: string, passphrasefile: string) => Promise<void>,
) {
  const root = await Deno.makeTempDir({ prefix: "backup's-encryption-" });
  const passphrasefile = root + '/passphrase';
  await Deno.writeTextFile(passphrasefile, 'not-an-argv-secret\n', {
    mode: 0o600,
  });
  try {
    await fn(root, passphrasefile);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test('backup encryption: defaults are off and the config layers override leaves', async () => {
  await fixture(async (root, passphrasefile) => {
    const path = root + '/overlay.toml';
    await Deno.writeTextFile(
      path,
      '[backup]\nencrypt=true\npassphrasefile=' +
        JSON.stringify(passphrasefile),
    );
    const defaults = loadConfig({
      defaultsPath: 'defaults/communico.toml',
      configPath: null,
      env: {},
    });
    assertEquals(defaults.config.backup, {
      encrypt: false,
      passphrasefile: '',
    });
    const overlay = loadConfig({
      defaultsPath: 'defaults/communico.toml',
      configPath: path,
      env: { COMMUNICO_BACKUP_ENCRYPT: 'false' },
    });
    assertEquals(overlay.config.backup, { encrypt: false, passphrasefile });
    assertEquals(overlay.sources['backup.encrypt'], 'env');
    assertEquals(await openCipher(defaults.config.backup, root), null);
  });
});

Deno.test('backup encryption: standard AES256 OpenPGP round trip with private output and preserved source', async () => {
  await fixture(async (root, passphrasefile) => {
    await Deno.mkdir(root + '/bundle/media', { recursive: true });
    await Deno.mkdir(root + '/restored/media', { recursive: true });
    const bytes = new Uint8Array(200000);
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      crypto.getRandomValues(bytes.subarray(offset, offset + 65536));
    }
    await Deno.writeFile(root + '/bundle/media/test', bytes, { mode: 0o600 });
    const payload = await describePayload(root + '/bundle', 'media/test');
    const cipher = await openCipher({ encrypt: true, passphrasefile }, root);
    assert(cipher);
    try {
      const encrypted = await cipher.encrypt(root + '/bundle', payload);
      assertEquals(encrypted.stored.path, 'media/test.gpg');
      assert(encrypted.stored.sha256 !== payload.sha256);
      assertEquals(
        (await Deno.stat(root + '/bundle/media/test.gpg')).mode! & 0o777,
        0o600,
      );
      assertEquals(await Deno.readFile(root + '/bundle/media/test'), bytes);
      await cipher.decrypt(root + '/bundle', encrypted, root + '/restored');
      assertEquals(await Deno.readFile(root + '/restored/media/test'), bytes);
      assertEquals(
        (await Deno.stat(root + '/restored/media/test')).mode! & 0o777,
        0o600,
      );
      await assertRejects(
        () => cipher.encrypt(root + '/bundle', payload),
        Deno.errors.AlreadyExists,
      );
      await assertRejects(
        () => cipher.decrypt(root + '/bundle', encrypted, root + '/restored'),
        Deno.errors.AlreadyExists,
      );
      assertEquals(await Deno.readFile(root + '/restored/media/test'), bytes);
    } finally {
      await cipher.close();
    }
  });
});

Deno.test('backup encryption: wrong passphrase, corrupted ciphertext and wrong plaintext digest never publish a candidate', async () => {
  await fixture(async (root, passphrasefile) => {
    await Deno.mkdir(root + '/bundle/media', { recursive: true });
    await Deno.mkdir(root + '/restored/media', { recursive: true });
    await Deno.writeTextFile(
      root + '/bundle/media/test',
      'acknowledged media',
      { mode: 0o600 },
    );
    const payload = await describePayload(root + '/bundle', 'media/test');
    const cipher = await openCipher({ encrypt: true, passphrasefile }, root);
    assert(cipher);
    try {
      const encrypted = await cipher.encrypt(root + '/bundle', payload);
      const wrongfile = root + '/wrong-passphrase';
      await Deno.writeTextFile(wrongfile, 'wrong\n', { mode: 0o600 });
      const wrong = await openCipher({
        encrypt: true,
        passphrasefile: wrongfile,
      }, root);
      assert(wrong);
      try {
        await assertRejects(
          () => wrong.decrypt(root + '/bundle', encrypted, root + '/restored'),
          Error,
          'OpenPGP',
        );
      } finally {
        await wrong.close();
      }
      await assertRejects(
        () => Deno.stat(root + '/restored/media/test'),
        Deno.errors.NotFound,
      );
      const altered = structuredClone(encrypted);
      altered.sha256 = '0'.repeat(64);
      await assertRejects(
        () => cipher.decrypt(root + '/bundle', altered, root + '/restored'),
        Error,
        'plaintext',
      );
      await assertRejects(
        () => Deno.stat(root + '/restored/media/test'),
        Deno.errors.NotFound,
      );
      const ciphertext = await Deno.readFile(root + '/bundle/media/test.gpg');
      ciphertext[ciphertext.length - 1] ^= 0xff;
      await Deno.writeFile(root + '/bundle/media/test.gpg', ciphertext);
      // Even if a forged manifest supplies the modified ciphertext digest,
      // OpenPGP's own integrity protection must reject it after decryption.
      const corrupt = await describePayload(root + '/bundle', 'media/test.gpg');
      encrypted.stored = {
        path: corrupt.path,
        size: corrupt.size,
        sha256: corrupt.sha256,
      };
      await assertRejects(
        () => cipher.decrypt(root + '/bundle', encrypted, root + '/restored'),
        Error,
        'OpenPGP',
      );
      await assertRejects(
        () => Deno.stat(root + '/restored/media/test'),
        Deno.errors.NotFound,
      );
    } finally {
      await cipher.close();
    }
  });
});

Deno.test('backup encryption: private passphrase source is required only when enabled', async () => {
  await fixture(async (root, passphrasefile) => {
    assertEquals(
      await openCipher(
        { encrypt: false, passphrasefile: root + '/missing' },
        root,
      ),
      null,
    );
    await assertRejects(
      () => openCipher({ encrypt: true, passphrasefile: '' }, root),
      Error,
      'passphrase',
    );
    await Deno.chmod(passphrasefile, 0o644);
    await assertRejects(
      () => openCipher({ encrypt: true, passphrasefile }, root),
      Error,
      'private',
    );
    await Deno.chmod(passphrasefile, 0o600);
    await Deno.symlink(passphrasefile, root + '/linked');
    await assertRejects(
      () =>
        openCipher({ encrypt: true, passphrasefile: root + '/linked' }, root),
      Error,
      'regular',
    );
  });
});
