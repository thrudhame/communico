import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import {
  consumeRefreshToken,
  hashToken,
  issueRefreshToken,
  issueToken,
  revokeToken,
} from '#engine/tenant/auth.ts';
import {
  recordPusherChange,
  setPusher,
  upsertPusherRow,
} from '#engine/tenant/pushers.ts';
import { registerOperations } from '#engine/facade/registers.ts';
import { deleteDevices } from '#engine/tenant/devices.ts';
import { deactivateUser } from '#engine/tenant/users.ts';

const input = {
  app_id: 'app',
  pushkey: 'key',
  kind: 'http',
  app_display_name: 'App',
  device_display_name: 'Device',
  lang: 'en',
  append: true,
  data: { url: 'https://gateway.test/_matrix/push/v1/notify' },
};

Deno.test('pusher source intent: native registration cannot silently omit source intent for an unknown or wrong-subject session', async (t) => {
  for (const mode of ['unknown', 'wrong-subject', 'missing-authority']) {
    await t.step(mode, async () => {
      const f = await fixture();
      try {
        const hash = mode === 'unknown'
          ? 'a'.repeat(64)
          : await hashToken(mode === 'wrong-subject' ? f.bob : f.alice);
        if (mode === 'missing-authority') {
          await f.db.execute('DELETE FROM session_authority WHERE hash=?', [
            hash,
          ]);
        }
        await assertRejects(() =>
          f.db.tx((conn) => upsertPusherRow(conn, 'alice', input, hash))
        );
        assertEquals(await f.row(), undefined);
        assertEquals(await f.db.query('SELECT * FROM pusher_changes'), []);
        assertEquals(
          await f.db.query(
            "SELECT * FROM domain_operations WHERE kind='pusher'",
          ),
          [],
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('pusher source intent: replaying a target projection cannot author registration facts', async () => {
  const f = await fixture();
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const row = await f.row();
    const before = await f.facts(row);
    await f.db.tx(async (conn) => {
      await recordPusherChange(conn, row, false);
      await recordPusherChange(conn, row, true);
    });
    assertEquals(await f.facts(row), before);
  } finally {
    await f.close();
  }
});

async function fixture(node = 'home') {
  const dir = await Deno.makeTempDir({ prefix: 'pusher-intent-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  const tenant = await openTenant(store, 'test', { create: true });
  await tenant.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  const db = await store.tenant('test');
  await db.tx((conn) =>
    activateTenantAuthority(conn, {
      node,
      incarnation: node + '-store',
      homeIncarnation: 'home-store',
      edgeNode: 'edge',
      edgeIncarnation: 'edge-store',
    })
  );
  const alice = await issueToken(tenant, 'alice', 'A');
  const bob = await issueToken(tenant, 'bob', 'B');
  const row = async (user = 'alice') =>
    (await db.query('SELECT * FROM pushers WHERE localpart=?', [user]))[0];
  const facts = (row: Record<string, unknown>) =>
    db.tx((conn) =>
      registerOperations(
        conn,
        JSON.stringify([
          'pusher',
          row.localpart,
          row.app_id,
          row.pushkey,
          row.incarnation,
        ]),
      )
    );
  return {
    tenant,
    db,
    alice,
    bob,
    row,
    facts,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('pusher source intent: ACK retains complete registration, replacement and append=false removal', async () => {
  const f = await fixture();
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const first = await f.row();
    const [put] = await f.facts(first);
    assert(put, 'pusher ACK has no semantic source intent');
    assertEquals(put.kind, 'pusher');
    assertEquals(put.source, 'home');
    assertEquals(JSON.parse(put.payload), {
      registration: {
        app_id: 'app',
        pushkey: 'key',
        kind: 'http',
        app_display_name: 'App',
        device_display_name: 'Device',
        profile_tag: null,
        lang: 'en',
        data: input.data,
      },
      accessHash: first.access_token,
      addedMs: first.added_ms,
    });
    assert(
      !put.payload.includes(f.alice),
      'bearer plaintext entered source intent',
    );
    await setPusher(f.tenant, 'alice', f.alice, input);
    assertEquals(JSON.parse((await f.facts(first)).at(-1)!.payload), null);
    const replacement = await f.row();
    assert(replacement.incarnation !== first.incarnation);
    await setPusher(f.tenant, 'bob', f.bob, { ...input, append: false });
    assertEquals(await f.row(), undefined);
    assertEquals(
      JSON.parse((await f.facts(replacement)).at(-1)!.payload),
      null,
    );
    assertEquals((await f.facts(await f.row('bob'))).length, 1);
  } finally {
    await f.close();
  }
});

Deno.test('pusher source intent: refresh moves protected digest in the same incarnation and revoke retains its tombstone', async () => {
  const f = await fixture();
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const first = await f.row();
    const refresh = await issueRefreshToken(f.tenant, 'alice', 'A', f.alice);
    const rotated = await consumeRefreshToken(f.tenant, refresh);
    const current = await f.row();
    assertEquals(current.incarnation, first.incarnation);
    const operations = await f.facts(current);
    assertEquals(operations.length, 2, 'refresh lost pusher recovery intent');
    assertEquals(
      JSON.parse(operations[1].payload).accessHash,
      current.access_token,
    );
    assertEquals(operations[1].context, [{
      source: 'home',
      incarnation: 'home-store',
      sequence: 1,
    }]);
    await revokeToken(f.tenant, rotated.accessToken);
    assertEquals(await f.row(), undefined);
    assertEquals(JSON.parse((await f.facts(current)).at(-1)!.payload), null);
  } finally {
    await f.close();
  }
});

Deno.test('pusher source intent: stale gateway rejection cannot tombstone a replacement', async () => {
  const f = await fixture();
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const first = await f.row();
    await setPusher(f.tenant, 'alice', f.alice, input);
    const current = await f.row();
    const before = await f.facts(current);
    const { deleteRejectedPusher } = await import('#engine/tenant/pushers.ts');
    await f.db.tx((conn) =>
      deleteRejectedPusher(
        conn,
        'alice',
        'app',
        'key',
        String(first.incarnation),
      )
    );
    assertEquals(await f.facts(current), before);
    await f.db.tx((conn) =>
      deleteRejectedPusher(
        conn,
        'alice',
        'app',
        'key',
        String(current.incarnation),
      )
    );
    assertEquals(JSON.parse((await f.facts(current)).at(-1)!.payload), null);
  } finally {
    await f.close();
  }
});

Deno.test('pusher source intent: failed lifecycle commit retains neither partial registration nor semantic fact', async () => {
  const f = await fixture();
  try {
    await f.db.exec(
      "CREATE TRIGGER refuse_pusher_intent BEFORE INSERT ON domain_operations WHEN NEW.kind='pusher' BEGIN SELECT RAISE(ABORT,'fixture source failure'); END",
    );
    await assertRejects(() => setPusher(f.tenant, 'alice', f.alice, input));
    assertEquals(await f.row(), undefined);
    assertEquals(await f.db.query('SELECT * FROM pusher_changes'), []);
    assertEquals(
      await f.db.query("SELECT * FROM domain_operations WHERE kind='pusher'"),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('pusher source intent: every existing lifecycle removal records the exact incarnation', async (t) => {
  for (const removal of ['client', 'device', 'account', 'logout-all']) {
    await t.step(removal, async () => {
      const f = await fixture();
      try {
        await setPusher(f.tenant, 'alice', f.alice, input);
        const first = await f.row();
        if (removal === 'client') {
          await setPusher(f.tenant, 'alice', f.alice, { ...input, kind: null });
        } else if (removal === 'device') {
          await deleteDevices(f.tenant, 'alice', ['A']);
        } else if (removal === 'account') {
          await deactivateUser(f.tenant, 'alice');
        } else {
          const { revokeAllTokens } = await import('#engine/tenant/auth.ts');
          await revokeAllTokens(f.tenant, 'alice');
        }
        assertEquals(await f.row(), undefined);
        const operations = await f.facts(first);
        assertEquals(operations.length, 2);
        assertEquals(JSON.parse(operations[1].payload), null);
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('pusher source intent: failed replacement preserves the old executable row and its untombstoned fact', async () => {
  const f = await fixture();
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const first = await f.row();
    const before = await f.facts(first);
    await f.db.exec(
      "CREATE TRIGGER refuse_pusher_replacement BEFORE INSERT ON pushers BEGIN SELECT RAISE(ABORT,'fixture replacement failure'); END",
    );
    await assertRejects(() => setPusher(f.tenant, 'alice', f.alice, input));
    assertEquals(await f.row(), first);
    assertEquals(await f.facts(first), before);
  } finally {
    await f.close();
  }
});

Deno.test('pusher source intent: failed refresh intent leaves the registration and retry chain unchanged', async () => {
  const f = await fixture();
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const row = await f.row();
    const before = await f.facts(row);
    const refresh = await issueRefreshToken(f.tenant, 'alice', 'A', f.alice);
    const tokens = await f.db.query(
      'SELECT * FROM access_tokens ORDER BY token',
    );
    const chain = await f.db.query(
      'SELECT * FROM refresh_tokens ORDER BY token',
    );
    await f.db.exec(
      "CREATE TRIGGER refuse_refresh_intent BEFORE INSERT ON domain_operations WHEN NEW.kind='pusher' BEGIN SELECT RAISE(ABORT,'fixture refresh source failure'); END",
    );
    await assertRejects(() => consumeRefreshToken(f.tenant, refresh));
    assertEquals(await f.row(), row);
    assertEquals(await f.facts(row), before);
    assertEquals(
      await f.db.query('SELECT * FROM access_tokens ORDER BY token'),
      tokens,
    );
    assertEquals(
      await f.db.query('SELECT * FROM refresh_tokens ORDER BY token'),
      chain,
    );
  } finally {
    await f.close();
  }
});

Deno.test('pusher source intent: a facade registration retains only its actual issuer provenance', async () => {
  const f = await fixture('edge');
  try {
    await setPusher(f.tenant, 'alice', f.alice, input);
    const [operation] = await f.facts(await f.row());
    assertEquals(operation.source, 'edge');
    assertEquals(operation.incarnation, 'edge-store');
    assertEquals(JSON.parse(operation.payload).registration.data, input.data);
  } finally {
    await f.close();
  }
});
