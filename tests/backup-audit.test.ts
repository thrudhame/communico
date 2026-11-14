import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { closeApp, openApp } from '#engine/app.ts';
import { createRoom } from '#engine/client/write.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { auditSnapshot } from '#engine/backup/audit.ts';
import { describePayload } from '#engine/backup/manifest.ts';

async function fixture() {
  const root = await Deno.makeTempDir({ prefix: 'backup-audit-' });
  const storage = {
    dir: join(root, 'live'),
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  setConfigForTests({ media: { root: join(root, 'media') } });
  const app = await openApp(storage);
  await app.delayedEvents.stop();
  const user = await registerUser(app.tenant, {
    localpart: 'audit',
    password: 'pw',
  });
  const room = await createRoom({ creator: user.user_id });
  const tenant = await openTenant(app.store, 'inactive.test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('inactive', 'Inactive');
    await tx.media.insert('inactive', 'cut-media', 'uploaded', {
      size_bytes: 3,
    });
    await tx.media.insert('inactive', 'pending-media', 'pending', {});
  });
  let serial = 0;
  async function capture() {
    const path = join(root, 'snapshot-' + ++serial);
    const cut = await app.store.snapshot(path);
    return { path, ...cut };
  }
  return {
    root,
    storage,
    app,
    room: room.roomId,
    capture,
    audit: async () => {
      const cut = await capture();
      return await auditSnapshot(
        storage,
        cut.path,
        cut.files,
        config().server.name,
        root,
      );
    },
    close: async () => {
      await closeApp();
      setConfigForTests({});
      await Deno.remove(root, { recursive: true });
    },
  };
}

Deno.test('backup audit: captured-only identity, streams and uploaded media include inactive tenants without modifying the cut', async () => {
  const f = await fixture();
  try {
    const cut = await f.capture();
    const before = await Promise.all(
      cut.files.map((file) => describePayload(cut.path, file.path)),
    );
    const result = await auditSnapshot(
      f.storage,
      cut.path,
      cut.files,
      config().server.name,
      f.root,
    );
    assertEquals(result.tenants.length, 2);
    const inactive = result.tenants.find((t) => t.id === 'inactive.test');
    assert(inactive);
    assertEquals(inactive.keyId.startsWith('ed25519:'), true);
    assertEquals(inactive.fingerprint.length, 64);
    assertEquals(result.media, [{
      tenant: 'inactive.test',
      id: 'cut-media',
      path: 'media/cut-media',
      size: 3,
    }]);
    assert(
      result.databases.some((db) => db.id === f.room && db.heads.changes > 0),
    );
    assertEquals(
      await Promise.all(
        cut.files.map((file) => describePayload(cut.path, file.path)),
      ),
      before,
    );
    for (const file of cut.files) {
      assertEquals(
        [...Deno.readDirSync(join(cut.path, file.path, '..'))].map((entry) =>
          entry.name
        ),
        ['data.db'],
      );
    }
    assertEquals(
      [...Deno.readDirSync(f.root)].filter((e) =>
        e.name.startsWith('.inspect-')
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: room DAG and references are audited, not just database page integrity', async () => {
  const f = await fixture();
  try {
    const db = await f.app.store.room(f.room);
    await db.execute('UPDATE event_topology SET height=1');
    await assertRejects(f.audit, Error, 'topology');
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: projection lag is recoverable, projection ahead of the room cut is refused', async () => {
  const f = await fixture();
  try {
    const server = await f.app.store.server();
    await server.execute('UPDATE watermarks SET position=0 WHERE source=?', [
      'room:' + f.room,
    ]);
    await f.audit();
    await server.execute(
      'UPDATE watermarks SET position=999999 WHERE source=?',
      ['room:' + f.room],
    );
    await assertRejects(f.audit, Error, 'watermark');
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: missing registered files and completed receipts pointing outside held room truth are refused', async () => {
  const f = await fixture();
  try {
    const tenant = await f.app.store.tenant(config().server.name);
    await tenant.execute('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?)', [
      'audit',
      'D',
      1,
      'endpoint',
      f.room,
      'txn',
      '$absent',
      null,
      1,
    ]);
    await assertRejects(f.audit, Error, 'completed receipt');
    await tenant.execute('DELETE FROM transactions');
    const server = await f.app.store.server();
    await server.execute('INSERT INTO rooms VALUES(?,?,?)', [
      '!absent:test',
      'wrong',
      Date.now(),
    ]);
    await assertRejects(f.audit, Error, 'registered room');
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: retired-room orphan watermark and historical completed receipt remain legitimate crash cuts', async () => {
  const f = await fixture();
  try {
    const tenant = await f.app.store.tenant(config().server.name);
    await tenant.execute('INSERT INTO transactions VALUES(?,?,?,?,?,?,?,?,?)', [
      'audit',
      'D',
      1,
      'endpoint',
      '!removed:test',
      'old',
      '$old',
      null,
      1,
    ]);
    const server = await f.app.store.server();
    for (const prefix of ['room:', 'push-context:', 'client-room-rules:']) {
      await server.execute('INSERT INTO watermarks VALUES(?,?)', [
        prefix + '!removed:test',
        17,
      ]);
    }
    const result = await f.audit();
    assertEquals(result.historicalUnheldReceipts, 1);
    await server.execute('INSERT INTO watermarks VALUES(?,?)', [
      'unknown-room-owner:!removed:test',
      17,
    ]);
    await assertRejects(f.audit, Error, 'watermark has no captured source');
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: allocator regression and mismatched signing material refuse publication', async () => {
  const f = await fixture();
  try {
    const tenant = await f.app.store.tenant(config().server.name);
    await tenant.exec(
      "INSERT INTO counters VALUES('account_data',0); INSERT INTO account_data VALUES('audit','','test','{}',1)",
    );
    await assertRejects(f.audit, Error, 'counter');
    await tenant.execute(
      "UPDATE counters SET value=1 WHERE name='account_data'",
    );
    const other = await f.app.store.tenant('inactive.test');
    const [{ pubkey_b64, native_name }] = await other.query(
      'SELECT pubkey_b64,native_name FROM tenant',
    );
    await tenant.execute('UPDATE tenant SET pubkey_b64=?,native_name=?', [
      pubkey_b64,
      native_name,
    ]);
    await assertRejects(f.audit, Error, 'signing');
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: cross-file source contracts include referenced events, actual tenant heads and projected reliable delivery', async (t) => {
  for (
    const [name, setup, message] of [
      [
        'foreign projection room',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
          await (await f.app.store.server()).execute(
            'UPDATE memberships SET room=?',
            ['!unheld:test'],
          );
        },
        'projection room',
      ],
      [
        'tenant watermark uses retained source, not only allocator',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
          const tenant = await f.app.store.tenant(config().server.name);
          await tenant.execute(
            "INSERT INTO counters VALUES('e2ee_changes',10) ON CONFLICT(name) DO UPDATE SET value=10",
          );
          await (await f.app.store.server()).execute(
            'INSERT INTO watermarks VALUES(?,?) ON CONFLICT(source) DO UPDATE SET position=excluded.position',
            ['tenant:' + config().server.name + ':e2ee', 10],
          );
        },
        'watermark',
      ],
      [
        'acknowledged reliable intent',
        async (f: Awaited<ReturnType<typeof fixture>>) => {
          await (await f.app.store.tenant(config().server.name)).execute(
            'INSERT INTO to_device_intents VALUES(?,?,?,?,?)',
            ['source', 'peer.test', '{}', '@audit:' + config().server.name, 1],
          );
        },
        'reliable intent',
      ],
      ['PDU and edge index', async (f: Awaited<ReturnType<typeof fixture>>) => {
        await (await f.app.store.room(f.room)).execute(
          'DELETE FROM prev_edges',
        );
      }, 'PDU edge'],
    ] as const
  ) {
    await t.step(name, async () => {
      const f = await fixture();
      try {
        await setup(f);
        await assertRejects(f.audit, Error, message);
      } finally {
        await f.close();
      }
    });
  }
});
