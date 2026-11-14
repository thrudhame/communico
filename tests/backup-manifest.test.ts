import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import {
  assertCompatible,
  decodeManifest,
  describePayload,
  type Manifest,
  readManifest,
  sealManifest,
} from '#engine/backup/manifest.ts';
import { EXPECTED_BUILD } from '#engine/store/build.ts';

function manifest(): Manifest {
  return {
    format: 1,
    backupId: 'b79760a3-499e-40e3-a0fe-de44bb3b974a',
    serverName: 'backup.test',
    applicationVersion: '0.1.0-dev',
    native: {
      turso_version: '0.8.3',
      turso_rev: EXPECTED_BUILD.tursoRev,
      patches: [...EXPECTED_BUILD.patches],
      default_features: false,
      features: ['fts'],
    },
    cut: {
      startedAt: '2026-11-13T21:00:00.000Z',
      endedAt: '2026-11-13T21:00:01.000Z',
      pauseMs: 200,
    },
    encryption: 'none',
    contains_signing_private_keys: true,
    contains_password_hashes: true,
    tenants: [{
      id: 'backup.test',
      nativeName: 'backup.test',
      keyId: 'ed25519:old',
      publicKey: 'public',
      fingerprint: 'a'.repeat(64),
    }],
    databases: [
      {
        kind: 'server',
        id: null,
        path: 'store/server/data.db',
        schemaVersion: 24,
        heads: { events: 2 },
      },
      {
        kind: 'tenants',
        id: 'backup.test',
        path: 'store/tenants/' + 'c'.repeat(32) + '/data.db',
        schemaVersion: 20,
        heads: { account_data: 1 },
      },
    ],
    media: [],
    deployment: [],
    configuration: {
      overlay: null,
      sources: { 'store.dir': 'env' },
      externalSecrets: ['COMMUNICO_TURN_SECRET'],
    },
    exclusions: ['remote-media-cache', 'runtime-files', 'unfinished-uploads'],
    payloads: [
      'store/server/data.db',
      'store/tenants/' + 'c'.repeat(32) + '/data.db',
    ].map((path) => ({
      path,
      size: 8,
      sha256: 'b'.repeat(64),
      stored: { path, size: 8, sha256: 'b'.repeat(64) },
    })),
  };
}

async function fixture(fn: (root: string, value: Manifest) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "backup's-manifest-" });
  const value = manifest();
  for (const db of value.databases) {
    await Deno.mkdir(root + '/' + db.path.slice(0, -8), {
      recursive: true,
      mode: 0o700,
    });
    await Deno.writeTextFile(root + '/' + db.path, 'snapshot', { mode: 0o600 });
  }
  value.payloads = await Promise.all(
    value.databases.map((db) => describePayload(root, db.path)),
  );
  try {
    await fn(root, value);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test('backup manifest: private manifest-last seal and verified portable read', async () => {
  await fixture(async (root, value) => {
    await assertRejects(() => readManifest(root), Error);
    await sealManifest(root, value);
    assertEquals(
      (await Deno.stat(root + '/manifest.json')).mode! & 0o777,
      0o600,
    );
    assertEquals(await readManifest(root), value);
    await assertRejects(
      () => sealManifest(root, value),
      Deno.errors.AlreadyExists,
    );
    assertEquals(await readManifest(root), value);
  });
});

Deno.test('backup manifest: corruption, truncation and unlisted filesystem entries refuse', async () => {
  await fixture(async (root, value) => {
    await sealManifest(root, value);
    await Deno.writeTextFile(root + '/store/server/data.db', 'tampered');
    await assertRejects(() => readManifest(root), Error, 'hash');
    await Deno.writeTextFile(root + '/store/server/data.db', 'short');
    await assertRejects(() => readManifest(root), Error, 'size');
    await Deno.writeTextFile(root + '/store/server/data.db', 'snapshot');
    await Deno.mkdir(root + '/unlisted');
    await assertRejects(() => readManifest(root), Error, 'inventory');
    await Deno.remove(root + '/unlisted');
    await Deno.writeTextFile(
      root + '/store/server/data.db-log',
      'not a payload',
    );
    await assertRejects(() => readManifest(root), Error, 'inventory');
  });
});

Deno.test('backup manifest: a torn completion file is not a backup and cannot be overwritten', async () => {
  await fixture(async (root, value) => {
    const open = Deno.open;
    Deno.open = async (path, options) => {
      const file = await open(path, options);
      if (path === root + '/manifest.json' && options?.write) {
        const write = file.write.bind(file);
        let partial = false;
        file.write = async (bytes) => {
          if (partial) throw new Error('injected torn manifest write');
          partial = true;
          return await write(bytes.subarray(0, 16));
        };
      }
      return file;
    };
    try {
      await assertRejects(() => sealManifest(root, value), Error, 'torn');
    } finally {
      Deno.open = open;
    }
    await assertRejects(() => readManifest(root), SyntaxError);
    await assertRejects(
      () => sealManifest(root, value),
      Deno.errors.AlreadyExists,
    );
    assertEquals(
      await Deno.readTextFile(root + '/store/server/data.db'),
      'snapshot',
    );
  });
});

Deno.test('backup manifest: symlink files, ancestors and bundle roots refuse without following', async () => {
  await fixture(async (root, value) => {
    await sealManifest(root, value);
    const side = await Deno.makeTempDir({ prefix: 'backup-symlink-target-' });
    try {
      await Deno.rename(root + '/store/server/data.db', side + '/outside');
      await Deno.symlink(side + '/outside', root + '/store/server/data.db');
      await assertRejects(() => readManifest(root), Error, 'regular');
      await Deno.remove(root + '/store/server/data.db');
      await Deno.rename(side + '/outside', root + '/store/server/data.db');
      await Deno.rename(root + '/store', side + '/moved');
      await Deno.symlink(side + '/moved', root + '/store');
      await assertRejects(() => readManifest(root), Error, 'regular');
      await Deno.remove(root + '/store');
      await Deno.rename(side + '/moved', root + '/store');
      await Deno.symlink(root, side + '/link');
      await assertRejects(() => readManifest(side + '/link'), Error, 'symlink');
    } finally {
      await Deno.remove(side, { recursive: true });
    }
  });
});

Deno.test('backup manifest: strict paths, identities, inventories and versioned shapes', () => {
  const valid = manifest();
  assertEquals(decodeManifest(valid), valid);
  const invalid: ((m: Manifest) => void)[] = [
    (m) => {
      (m as { format: number }).format = 2;
    },
    (m) => {
      m.payloads[0].path = '../escape';
    },
    (m) => {
      m.payloads[0].stored.path = '/absolute';
    },
    (m) => {
      m.payloads[0].path = 'store//server/data.db';
    },
    (m) => {
      m.payloads[0].path = 'store\\server\\data.db';
    },
    (m) => {
      m.payloads[0].path = 'store/server/data.db\0';
    },
    (m) => {
      m.payloads.push(structuredClone(m.payloads[0]));
    },
    (m) => {
      m.databases[0].id = 'wrong';
    },
    (m) => {
      m.databases[0].schemaVersion = 1.1;
    },
    (m) => {
      m.payloads[0].size = -1;
    },
    (m) => {
      m.payloads[0].sha256 = 'invalid';
    },
    (m) => {
      m.tenants.push(structuredClone(m.tenants[0]));
    },
    (m) => {
      m.serverName = 'missing.test';
    },
    (m) => {
      m.configuration.sources['store.dir'] = 'secret-value' as 'env';
    },
    (m) => {
      m.configuration.externalSecrets = ['password value'];
    },
    (m) => {
      m.cut.endedAt = '2026-11-12T21:00:00.000Z';
    },
    (m) => {
      m.cut.pauseMs = NaN;
    },
    (m) => {
      m.encryption = 'openpgp-aes256';
    },
    (m) => {
      m.payloads = [];
    },
    (m) => {
      (m as unknown as Record<string, unknown>).password = 'not allowed';
    },
  ];
  for (const mutate of invalid) {
    const value = structuredClone(valid);
    mutate(value);
    assertThrows(() => decodeManifest(value), Error);
  }
});

Deno.test('backup manifest: schema compatibility is separate from format compatibility', () => {
  const value = manifest();
  assertCompatible(decodeManifest(value), {
    server: 24,
    rooms: 5,
    tenants: 20,
  });
  assertThrows(
    () => assertCompatible(value, { server: 23, rooms: 5, tenants: 20 }),
    Error,
    'newer schema',
  );
  // An older schema can be structurally valid; its migration chain is checked
  // only in the private restore candidate, never by opening this bundle.
  value.databases[0].schemaVersion = 23;
  assertCompatible(decodeManifest(value), {
    server: 24,
    rooms: 5,
    tenants: 20,
  });
});

Deno.test('backup manifest: encrypted-payload digests are separate from plaintext digests', async () => {
  await fixture(async (root, value) => {
    value.encryption = 'openpgp-aes256';
    for (const payload of value.payloads) {
      await Deno.writeTextFile(
        root + '/' + payload.path + '.gpg',
        'ciphertext',
        { mode: 0o600 },
      );
      const encrypted = await describePayload(root, payload.path + '.gpg');
      payload.stored = {
        path: encrypted.path,
        size: encrypted.size,
        sha256: encrypted.sha256,
      };
      await Deno.remove(root + '/' + payload.path);
    }
    await sealManifest(root, value);
    assertEquals(await readManifest(root), value);
    await Deno.writeTextFile(root + '/store/server/data.db.gpg', 'bad cipher');
    await assertRejects(() => readManifest(root), Error, 'hash');
  });
});
