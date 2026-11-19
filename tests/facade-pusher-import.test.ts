import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  activateTenantAuthority,
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  issueToken,
} from '#engine/tenant/auth.ts';
import {
  capturePusherOperations,
  importPusherOperation,
  pusherOperations,
  setPusher,
} from '#engine/tenant/pushers.ts';
import {
  importRegisterOperation,
  readRegister,
  type RegisterOperation,
  writeRegister,
} from '#engine/facade/registers.ts';

const input = {
  app_id: 'app',
  pushkey: 'key',
  kind: 'http',
  app_display_name: 'App',
  device_display_name: 'Device',
  profile_tag: null,
  lang: 'en',
  append: true,
  data: { url: 'https://push.test/_matrix/push/v1/notify' },
};

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'pusher-import-' });
  const options = {
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const home = await openStore({ ...options, dir: dir + '/home' }, {
    schemas: { tenant: tenantSchema },
  });
  const edge = await openStore({ ...options, dir: dir + '/edge' }, {
    schemas: { tenant: tenantSchema },
  });
  const ht = await openTenant(home, 'test', { create: true });
  const et = await openTenant(edge, 'test', { create: true });
  const hd = await home.tenant('test'), ed = await edge.tenant('test');
  for (
    const [node, tenant, db] of [['home', ht, hd], ['edge', et, ed]] as const
  ) {
    await tenant.tx(async (tx) => {
      await tx.users.insert('alice', 'Alice');
      await tx.users.insert('bob', 'Bob');
    });
    await db.tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
  }
  const token = await issueToken(ht, 'alice', 'PUSH');
  const syncSessions = async () => {
    const view = await hd.tx((conn) => captureSessionAuthority(conn, 'alice'));
    await ed.tx((conn) => installSessionAuthority(conn, 'alice', view));
  };
  return {
    home,
    edge,
    ht,
    et,
    hd,
    ed,
    token,
    syncSessions,
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('pusher import: all refresh/remove delivery orders retain protected facts but never executable rows', async (t) => {
  for (
    const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [
      2,
      1,
      0,
    ]]
  ) {
    await t.step(order.join(','), async () => {
      const f = await fixture();
      try {
        await setPusher(f.ht, 'alice', f.token, input);
        const refresh = await issueRefreshToken(f.ht, 'alice', 'PUSH', f.token);
        const rotated = await consumeRefreshToken(f.ht, refresh);
        await setPusher(f.ht, 'alice', rotated.accessToken, {
          ...input,
          kind: null,
        });
        const ops = await f.ht.tx((tx) => tx.pushers.operations('alice'));
        assertEquals(ops.length, 3);
        await f.syncSessions();
        for (const n of order) {
          await f.et.tx((tx) => tx.pushers.import(ops[n]));
          await f.et.tx((tx) => tx.pushers.import(ops[n]));
          assertEquals(await f.ed.query('SELECT * FROM pushers'), []);
          assertEquals(await f.ed.query('SELECT * FROM pusher_changes'), []);
        }
        assertEquals(
          await f.et.tx((tx) => tx.pushers.operations('alice')),
          ops,
        );
        const view = await f.ed.tx((conn) =>
          readRegister(conn, ops[0].semanticKey)
        );
        assertEquals(view.pending, []);
        assertEquals(view.winner?.payload, 'null');
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('pusher import: an authentic incomplete null fences exactly its native incarnation without authoring an echo', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const [put] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    await f.ed.tx((conn) => importRegisterOperation(conn, put));
    const { operation: precursor } = await f.ed.tx((conn) =>
      writeRegister(
        conn,
        { source: 'edge', incarnation: 'edge-store' },
        put.semanticKey,
        'pusher',
        'null',
      )
    );
    const { operation: remove } = await f.ed.tx((conn) =>
      writeRegister(
        conn,
        { source: 'edge', incarnation: 'edge-store' },
        put.semanticKey,
        'pusher',
        'null',
      )
    );
    await f.ht.tx((tx) => tx.pushers.import(remove));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), []);
    assertEquals(
      (await f.hd.tx((conn) => readRegister(conn, put.semanticKey))).pending,
      [remove],
    );
    const changes = await f.hd.query('SELECT * FROM pusher_changes');
    await f.ht.tx((tx) => tx.pushers.import(precursor));
    await f.ht.tx((tx) => tx.pushers.import(remove));
    assertEquals(await f.hd.query('SELECT * FROM pusher_changes'), changes);
    assertEquals(
      (await f.ht.tx((tx) => tx.pushers.operations('alice'))).length,
      3,
    );
    await setPusher(f.ht, 'alice', f.token, input);
    const [replacement] = await f.hd.query('SELECT * FROM pushers');
    await f.ht.tx((tx) => tx.pushers.import(remove));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), [replacement]);
  } finally {
    await f.close();
  }
});

function payload(op: RegisterOperation, value: unknown) {
  const body = JSON.stringify(value);
  return {
    ...op,
    payload: body,
    payloadHash: createHash('sha256').update(body).digest('hex'),
  };
}

Deno.test('pusher import: missing provenance retries, mismatched and malformed private facts reject atomically', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const [put] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    await assertRejects(
      () => f.et.tx((tx) => tx.pushers.import(put)),
      Error,
      'awaits session provenance',
    );
    assertEquals(await f.et.tx((tx) => tx.pushers.operations('alice')), []);
    await f.syncSessions();
    const value = JSON.parse(put.payload);
    const bob = await issueToken(f.ht, 'bob', 'BOB');
    const { hashToken } = await import('#engine/tenant/auth.ts');
    const bobView = await f.hd.tx((conn) =>
      captureSessionAuthority(conn, 'bob')
    );
    await f.ed.tx((conn) => installSessionAuthority(conn, 'bob', bobView));
    for (
      const invalid of [
        { ...put, source: 'stranger' },
        payload(put, { ...value, accessHash: await hashToken(bob) }),
        payload(put, { ...value, secretExtra: 'must-not-echo' }),
        payload(put, {
          ...value,
          registration: { ...value.registration, pushkey: 'different' },
        }),
        { ...put, payload: '{"private-value-do-not-log"' },
      ]
    ) {
      const error = await assertRejects(() =>
        f.et.tx((tx) => tx.pushers.import(invalid))
      );
      assert(error instanceof Error);
      assert(!error.message.includes('private-value-do-not-log'));
      assertEquals(await f.et.tx((tx) => tx.pushers.operations('alice')), []);
    }
    await f.et.tx((tx) => tx.pushers.import(put));
    assertEquals(await f.et.tx((tx) => tx.pushers.operations('alice')), [put]);
  } finally {
    await f.close();
  }
});

Deno.test('pusher import: projection cancellation failure rolls back the retained null and native deletion together', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const [put] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    const { operation: remove } = await f.ed.tx((conn) =>
      writeRegister(
        conn,
        { source: 'edge', incarnation: 'edge-store' },
        put.semanticKey,
        'pusher',
        'null',
      )
    );
    const before = await f.hd.query('SELECT * FROM pushers');
    await f.hd.exec(
      "CREATE TRIGGER refuse_imported_removal BEFORE INSERT ON pusher_changes WHEN NEW.payload IS NULL BEGIN SELECT RAISE(ABORT,'fixture cancellation failure'); END",
    );
    await assertRejects(() =>
      f.hd.tx((conn) => importPusherOperation(conn, remove))
    );
    assertEquals(await f.hd.query('SELECT * FROM pushers'), before);
    assertEquals(await f.ht.tx((tx) => tx.pushers.operations('alice')), [put]);
  } finally {
    await f.close();
  }
});

Deno.test('pusher import: same-incarnation successors cannot change immutable registration or original added time', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const [put] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    await f.syncSessions();
    await f.et.tx((tx) => tx.pushers.import(put));
    const body = JSON.parse(put.payload);
    for (
      const value of [
        { ...body, addedMs: body.addedMs + 1 },
        {
          ...body,
          registration: { ...body.registration, app_display_name: 'Changed' },
        },
      ]
    ) {
      const { operation } = await f.hd.tx((conn) =>
        writeRegister(
          conn,
          { source: put.source, incarnation: put.incarnation },
          put.semanticKey,
          'pusher',
          JSON.stringify(value),
        )
      );
      await assertRejects(
        () => f.et.tx((tx) => tx.pushers.import(operation)),
        Error,
        'immutable pusher registration differs',
      );
      assertEquals(await f.et.tx((tx) => tx.pushers.operations('alice')), [
        put,
      ]);
    }
  } finally {
    await f.close();
  }
});

Deno.test('pusher import: legacy home capture is idempotent, keeps added time and emits no target news', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const before = await f.hd.query('SELECT * FROM pushers');
    const changes = await f.hd.query('SELECT * FROM pusher_changes');
    await f.hd.execute(
      "DELETE FROM domain_operations WHERE kind IN ('pusher','pusher-choice')",
    );
    const ops = await f.hd.tx((conn) => capturePusherOperations(conn, 'alice'));
    assertEquals(ops.length, 1);
    assertEquals(JSON.parse(ops[0].payload).addedMs, before[0].added_ms);
    assertEquals(
      await f.hd.tx((conn) => capturePusherOperations(conn, 'alice')),
      ops,
    );
    assertEquals(await f.hd.query('SELECT * FROM pushers'), before);
    assertEquals(await f.hd.query('SELECT * FROM pusher_changes'), changes);
    await assertRejects(() =>
      f.ed.tx((conn) => capturePusherOperations(conn, 'alice'))
    );
    assertEquals(await f.ed.tx((conn) => pusherOperations(conn, 'alice')), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher removal: kind=null retires observed foreign registrations and survives late refresh', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const refresh = await issueRefreshToken(f.ht, 'alice', 'PUSH', f.token);
    const rotated = await consumeRefreshToken(f.ht, refresh);
    const [put, moved] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    await f.syncSessions();
    await f.et.tx((tx) => tx.pushers.import(put));
    const edgeToken = await issueToken(f.et, 'alice', 'EDGE');
    await setPusher(f.et, 'alice', edgeToken, { ...input, kind: null });
    const nulls = (await f.et.tx((tx) => tx.pushers.operations('alice')))
      .filter((op) => op.payload === 'null');
    assertEquals(nulls.length, 1);
    assertEquals(nulls[0].semanticKey, put.semanticKey);
    assertEquals(nulls[0].source, 'edge');
    assertEquals(nulls[0].context.length, 1);
    await f.et.tx((tx) => tx.pushers.import(moved));
    await f.ht.tx((tx) => tx.pushers.import(nulls[0]));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), []);
    assertEquals(await f.ed.query('SELECT * FROM pushers'), []);
    const before = await f.et.tx((tx) => tx.pushers.operations('alice'));
    await setPusher(f.et, 'alice', edgeToken, { ...input, kind: null });
    assertEquals(await f.et.tx((tx) => tx.pushers.operations('alice')), before);
    await setPusher(f.ht, 'alice', rotated.accessToken, input);
    const [replacement] = await f.hd.query('SELECT * FROM pushers');
    await f.ht.tx((tx) => tx.pushers.import(nulls[0]));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), [replacement]);
  } finally {
    await f.close();
  }
});

Deno.test('pusher removal: replacement retires the observed foreign incarnation, never another account with append=true', async () => {
  const f = await fixture();
  try {
    const bob = await issueToken(f.ht, 'bob', 'BOB');
    for (const [user, token] of [['alice', f.token], ['bob', bob]]) {
      await setPusher(f.ht, user, token, input);
      const view = await f.hd.tx((conn) => captureSessionAuthority(conn, user));
      await f.ed.tx((conn) => installSessionAuthority(conn, user, view));
      for (const op of await f.ht.tx((tx) => tx.pushers.operations(user))) {
        await f.et.tx((tx) => tx.pushers.import(op));
      }
    }
    const edgeToken = await issueToken(f.et, 'alice', 'EDGE');
    await setPusher(f.et, 'alice', edgeToken, input);
    const nulls = (await f.et.tx((tx) => tx.pushers.operations('alice')))
      .filter((op) => op.payload === 'null');
    assertEquals(nulls.length, 1);
    assertEquals(
      (await f.et.tx((tx) => tx.pushers.operations('bob')))
        .filter((op) => op.payload === 'null'),
      [],
    );
    await f.ht.tx((tx) => tx.pushers.import(nulls[0]));
    assertEquals(await f.hd.query('SELECT localpart FROM pushers'), [{
      localpart: 'bob',
    }]);
    assertEquals(await f.ed.query('SELECT localpart FROM pushers'), [{
      localpart: 'alice',
    }]);
  } finally {
    await f.close();
  }
});

Deno.test('pusher removal: observed-other-user and terminal-account removal include protected facts', async (t) => {
  for (const action of ['other-user', 'user', 'token'] as const) {
    await t.step(action, async () => {
      const f = await fixture();
      try {
        await setPusher(f.ht, 'alice', f.token, input);
        const [put] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
        await f.syncSessions();
        await f.et.tx((tx) => tx.pushers.import(put));
        if (action === 'other-user') {
          const bob = await issueToken(f.et, 'bob', 'BOB');
          await setPusher(f.et, 'bob', bob, { ...input, append: false });
        } else if (action === 'user') {
          await f.et.tx((tx) => tx.pushers.deleteForUser('alice'));
        } else {
          const { hashToken } = await import('#engine/tenant/auth.ts');
          const hash = await hashToken(f.token);
          await f.et.tx((tx) => tx.pushers.deleteForToken(hash));
        }
        const nulls = (await f.et.tx((tx) => tx.pushers.operations('alice')))
          .filter((op) => op.payload === 'null');
        assertEquals(nulls.length, 1);
        await f.ht.tx((tx) => tx.pushers.import(nulls[0]));
        assertEquals(await f.hd.query('SELECT * FROM pushers'), []);
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('pusher removal: a pending foreign refresh is observed and fenced before its predecessor arrives', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const refresh = await issueRefreshToken(f.ht, 'alice', 'PUSH', f.token);
    await consumeRefreshToken(f.ht, refresh);
    const [put, moved] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
    await f.syncSessions();
    await f.et.tx((tx) => tx.pushers.import(moved));
    const edgeToken = await issueToken(f.et, 'alice', 'EDGE');
    await setPusher(f.et, 'alice', edgeToken, { ...input, kind: null });
    const nulls = (await f.et.tx((tx) => tx.pushers.operations('alice')))
      .filter((op) => op.payload === 'null');
    assertEquals(nulls.length, 1);
    await f.et.tx((tx) => tx.pushers.import(put));
    await f.ht.tx((tx) => tx.pushers.import(nulls[0]));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), []);
    assertEquals(await f.ed.query('SELECT * FROM pushers'), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher removal: historical token revocation preserves the refreshed foreign registration', async () => {
  const f = await fixture();
  try {
    await setPusher(f.ht, 'alice', f.token, input);
    const refresh = await issueRefreshToken(f.ht, 'alice', 'PUSH', f.token);
    const rotated = await consumeRefreshToken(f.ht, refresh);
    await f.syncSessions();
    for (const op of await f.ht.tx((tx) => tx.pushers.operations('alice'))) {
      await f.et.tx((tx) => tx.pushers.import(op));
    }
    const { hashToken } = await import('#engine/tenant/auth.ts');
    const oldHash = await hashToken(f.token);
    const newHash = await hashToken(rotated.accessToken);
    const before = await f.et.tx((tx) => tx.pushers.operations('alice'));
    await f.et.tx((tx) => tx.pushers.deleteForToken(oldHash));
    assertEquals(await f.et.tx((tx) => tx.pushers.operations('alice')), before);
    await f.et.tx((tx) => tx.pushers.deleteForToken(newHash));
    const nulls = (await f.et.tx((tx) => tx.pushers.operations('alice')))
      .filter((op) => op.payload === 'null');
    assertEquals(nulls.length, 1);
    await f.ht.tx((tx) => tx.pushers.import(nulls[0]));
    assertEquals(await f.hd.query('SELECT * FROM pushers'), []);
  } finally {
    await f.close();
  }
});

Deno.test('pusher removal: retained cancellation failure rolls back native cancellation and replacement too', async (t) => {
  for (const action of ['remove', 'replace'] as const) {
    await t.step(action, async () => {
      const f = await fixture();
      try {
        await setPusher(f.ht, 'alice', f.token, input);
        await f.syncSessions();
        const [foreign] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
        const edgeToken = await issueToken(f.et, 'alice', 'EDGE');
        await setPusher(f.et, 'alice', edgeToken, input);
        await f.et.tx((tx) => tx.pushers.import(foreign));
        const rows = await f.ed.query('SELECT * FROM pushers');
        const changes = await f.ed.query('SELECT * FROM pusher_changes');
        const operations = await f.et.tx((tx) =>
          tx.pushers.operations('alice')
        );
        const incarnation = JSON.parse(foreign.semanticKey)[4];
        await f.ed.exec(
          `CREATE TRIGGER refuse_foreign_removal BEFORE INSERT ON domain_operations
           WHEN NEW.payload_json='null' AND json_extract(NEW.semantic_key,'$[4]')='${incarnation}'
           BEGIN SELECT RAISE(ABORT,'fixture retained cancellation failure'); END`,
        );
        await assertRejects(() =>
          setPusher(f.et, 'alice', edgeToken, {
            ...input,
            kind: action === 'remove' ? null : 'http',
          })
        );
        assertEquals(await f.ed.query('SELECT * FROM pushers'), rows);
        assertEquals(await f.ed.query('SELECT * FROM pusher_changes'), changes);
        assertEquals(
          await f.et.tx((tx) => tx.pushers.operations('alice')),
          operations,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('pusher removal: importing terminal authority cancels execution without authoring new pusher history', async (t) => {
  for (const native of [false, true]) {
    await t.step(
      native ? 'issuer-local row' : 'foreign recovery only',
      async () => {
        const f = await fixture();
        try {
          await setPusher(f.ht, 'alice', f.token, input);
          await f.syncSessions();
          const [put] = await f.ht.tx((tx) => tx.pushers.operations('alice'));
          await f.et.tx((tx) => tx.pushers.import(put));
          const { deactivateUser } = await import('#engine/tenant/users.ts');
          const source = native ? f.et : f.ht;
          const target = native ? f.ht : f.et;
          const sourceDb = native ? f.ed : f.hd;
          const targetDb = native ? f.hd : f.ed;
          await deactivateUser(source, 'alice');
          const before = await target.tx((tx) =>
            tx.pushers.operations('alice')
          );
          const view = await sourceDb.tx((conn) =>
            captureSessionAuthority(conn, 'alice')
          );
          await targetDb.tx((conn) =>
            installSessionAuthority(conn, 'alice', view)
          );
          assertEquals(await targetDb.query('SELECT * FROM pushers'), []);
          assertEquals(
            await target.tx((tx) => tx.pushers.operations('alice')),
            before,
          );
        } finally {
          await f.close();
        }
      },
    );
  }
});
