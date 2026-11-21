import { assert, assertEquals, assertRejects } from '@std/assert';
import { join } from '@std/path';
import { closeApp, openApp } from '#engine/app.ts';
import { createRoom } from '#engine/client/write.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { auditSnapshot } from '#engine/backup/audit.ts';
import { describePayload } from '#engine/backup/manifest.ts';
import { roomProjectionSources } from '#engine/store/projection-sources.ts';
import { recoverServer } from '#engine/server/startup.ts';
import { upgradeRoom } from '#engine/client/upgrade.ts';
import { inspectSnapshot } from '#engine/store/inspect.ts';
import { inventoryRestoredWork } from '#engine/backup/work.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { tenantSchema } from '#engine/tenant/index.ts';
import { roomSchema } from '#engine/room/schema.ts';

Deno.test('backup audit: ordinary valid v12 creation is audited without an upgrade journal', async () => {
  const f = await fixture();
  try {
    await f.audit();
    await createRoom({
      creator: '@audit:' + f.app.tenant.serverName,
      version: '12',
    });
    assertEquals(await f.app.server.query('SELECT * FROM room_upgrades'), []);
    await f.audit();
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: actual pending upgrade identity and private restored-work inventory survive the cut', async () => {
  const f = await fixture();
  try {
    const user = '@audit:' + f.app.tenant.serverName;
    const initialize = f.app.store.initializeRoom.bind(f.app.store);
    let injected = false;
    f.app.store.initializeRoom = () => {
      injected = true;
      return Promise.reject(new Error('backup-upgrade-cut'));
    };
    try {
      await assertRejects(
        () => upgradeRoom(f.room, user, '12'),
        Error,
        'backup-upgrade-cut',
      );
    } finally {
      f.app.store.initializeRoom = initialize;
    }
    assertEquals(injected, true);
    const [intent] = await f.app.server.query(
      'SELECT * FROM room_upgrades WHERE old_room_id=?',
      [f.room],
    );
    assertEquals(intent.phase, 0);
    await f.audit();
    const cut = await f.capture();
    await inspectSnapshot(f.storage, cut.path, cut.files, f.root, {
      server: serverSchema,
      tenant: tenantSchema,
      room: roomSchema,
    }, async (snapshot) => {
      const inventory = await inventoryRestoredWork(snapshot, Date.now());
      assertEquals(inventory.upgrades, [{
        old_room_id: f.room,
        user_id: user,
        replacement_room: intent.replacement_room,
        phase: 0,
      }]);
      const text = JSON.stringify(inventory.upgrades);
      assertEquals(text.includes('plan_json'), false);
      assertEquals(text.includes('createPdu'), false);
      assertEquals(text.includes('powerLevels'), false);
    });
    const original = JSON.parse(String(intent.plan_json));
    for (const column of ['user_id', 'replacement_room', 'plan_json']) {
      const changed = structuredClone(original);
      changed.prepared.createPdu.content.predecessor.room_id =
        '!different:test';
      await f.app.server.execute(
        'UPDATE room_upgrades SET ' + column + '=? WHERE old_room_id=?',
        [
          column === 'plan_json' ? JSON.stringify(changed) : 'different',
          f.room,
        ],
      );
      try {
        await assertRejects(
          f.audit,
          Error,
          'room upgrade intent identity differs',
        );
      } finally {
        await f.app.server.execute(
          'UPDATE room_upgrades SET ' + column + '=? WHERE old_room_id=?',
          [intent[column], f.room],
        );
      }
    }
    assertEquals(await upgradeRoom(f.room, user, '12'), {
      replacement_room: intent.replacement_room,
    });
    await f.audit();
    const completed = await f.capture();
    await inspectSnapshot(f.storage, completed.path, completed.files, f.root, {
      server: serverSchema,
      tenant: tenantSchema,
      room: roomSchema,
    }, async (snapshot) => {
      assertEquals(
        (await inventoryRestoredWork(snapshot, Date.now())).upgrades,
        [],
      );
    });
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: report distributed identity cannot lose its retained source fact', async () => {
  const f = await fixture();
  try {
    await f.app.server.execute(
      "INSERT INTO reports(report_id,kind,reporter,user_id,reason,received_ms) VALUES('orphan-source','user','@audit:test','@other:test','private',1)",
    );
    await assertRejects(
      f.audit,
      Error,
      'report identity or source fact differs',
    );
  } finally {
    await f.close();
  }
});

async function fixture(version = '11') {
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
  const room = await createRoom({ creator: user.user_id, version });
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

Deno.test('backup audit: ordinary v12 identity is create-derived and corrupt room fields stay refused', async (t) => {
  const f = await fixture('12');
  try {
    assert(!f.room.includes(':'));
    const db = await f.app.store.room(f.room);
    const rows = await db.query('SELECT id,pdu FROM events ORDER BY id');
    const create = rows.find((row) =>
      JSON.parse(String(row.pdu)).type === 'm.room.create'
    )!;
    const member = rows.find((row) =>
      JSON.parse(String(row.pdu)).type === 'm.room.member'
    )!;
    await t.step(
      'ordinary room without an upgrade journal audits',
      async () => {
        const server = await f.app.store.server();
        const journalTables = await server.query(
          "SELECT name FROM sqlite_master WHERE name='room_upgrades'",
        );
        assertEquals(
          journalTables.length
            ? await server.query('SELECT * FROM room_upgrades')
            : [],
          [],
        );
        await f.audit();
      },
    );
    for (
      const [name, row, change] of [
        ['create reference', create, { event_id: '$' + 'A'.repeat(43) }],
        ['create reference hash', create, {
          content: {
            room_version: '12',
            additional_creators: ['@other:logical.test'],
          },
        }],
        ['missing create version', create, { content: {} }],
        ['numeric create version', create, { content: { room_version: 12 } }],
        ['unsupported create version', create, {
          content: { room_version: 'unknown' },
        }],
        ['create room field', create, { room_id: '!wrong:elsewhere.test' }],
        ['member room field', member, { room_id: '!wrong:elsewhere.test' }],
        ['missing member room', member, { room_id: undefined }],
        ['indexed field', member, { sender: '@wrong:elsewhere.test' }],
      ] as const
    ) {
      await t.step(name, async () => {
        await db.execute('UPDATE events SET pdu=? WHERE id=?', [
          JSON.stringify({ ...JSON.parse(String(row.pdu)), ...change }),
          row.id,
        ]);
        try {
          await assertRejects(f.audit, Error, 'room PDU/index mismatch');
        } finally {
          await db.execute('UPDATE events SET pdu=? WHERE id=?', [
            row.pdu,
            row.id,
          ]);
        }
      });
    }
  } finally {
    await f.close();
  }
});

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
    const room = await f.app.store.room(f.room);
    // A completed callback witness cannot be ahead of publication. Rewinding
    // only the old watermark now models corruption, not recoverable lag.
    await server.execute('UPDATE watermarks SET position=0 WHERE source=?', [
      'room:' + f.room,
    ]);
    await assertRejects(f.audit, Error, 'completion progress past publication');
    await room.execute('UPDATE completion_state SET completed_through=0');
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
    for (const { prefix } of Object.values(roomProjectionSources)) {
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

Deno.test('backup audit: every room cursor uses the captured cut and startup clears only recognized orphan cursors', async () => {
  const f = await fixture();
  try {
    const server = await f.app.store.server();
    for (const { prefix } of Object.values(roomProjectionSources)) {
      await server.execute(
        'INSERT INTO watermarks VALUES(?,999999) ON CONFLICT(source) DO UPDATE SET position=999999',
        [prefix + f.room],
      );
      await assertRejects(f.audit, Error, 'watermark ahead of captured source');
      await server.execute('UPDATE watermarks SET position=0 WHERE source=?', [
        prefix + f.room,
      ]);
      await server.execute('INSERT INTO watermarks VALUES(?,17)', [
        prefix + '!removed:test',
      ]);
    }
    await server.execute(
      "INSERT INTO watermarks VALUES('unknown-owner:!removed:test',17)",
    );
    await recoverServer(f.app.store);
    assertEquals(
      await server.query(
        "SELECT source FROM watermarks WHERE source LIKE '%!removed:test'",
      ),
      [{ source: 'unknown-owner:!removed:test' }],
    );
    await assertRejects(f.audit, Error, 'watermark has no captured source');
  } finally {
    await f.close();
  }
});

Deno.test('backup audit: receipt graph projections must name authentic captured event, edge and membership evidence', async (t) => {
  for (
    const [name, sql] of [
      ['unheld room', "UPDATE receipt_dag_nodes SET room='!missing:test'"],
      ['unheld event', "INSERT INTO receipt_dag_nodes VALUES(?, '$missing')"],
      ['invented parent', "UPDATE receipt_dag_edges SET parent='$missing'"],
      [
        'invented membership',
        "UPDATE receipt_membership_events SET membership='ban'",
      ],
    ]
  ) {
    await t.step(name, async () => {
      const f = await fixture();
      try {
        const server = await f.app.store.server();
        await server.execute(sql, sql.includes('?') ? [f.room] : []);
        await assertRejects(
          f.audit,
          Error,
          name === 'unheld room' ? 'projection room' : 'receipt graph',
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('backup audit: an unregistered durable table cannot bypass the captured-file contract', async () => {
  const f = await fixture();
  try {
    await (await f.app.store.server()).exec(
      'CREATE TABLE unknown_durable_state(value TEXT)',
    );
    await assertRejects(f.audit, Error, 'unregistered durable table');
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
