import { assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import {
  captureAccountDataOperations,
  getAccountData,
  putAccountData,
} from '#engine/tenant/accountdata.ts';
import {
  captureProfileOperations,
  setProfileField,
} from '#engine/tenant/profiles.ts';
import { capturePushRuleOperations } from '#engine/tenant/pushrules.ts';

Deno.test('facade bootstrap: each owner captures its pre-F2 semantic value once without new client news', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-domain-bootstrap-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const store = await openStore({ ...options, dir: dir + '/home' }, {
    schemas: { tenant: tenantSchema },
  });
  const edgeStore = await openStore({ ...options, dir: dir + '/edge' }, {
    schemas: { tenant: tenantSchema },
  });
  try {
    const home = await openTenant(store, 'logical.test', { create: true });
    const edge = await openTenant(edgeStore, 'logical.test', { create: true });
    for (const tenant of [home, edge]) {
      await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    }
    await putAccountData(home, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'retained-secret',
      fractional: 0.125,
    });
    await putAccountData(home, 'alice', '!old:logical.test', 'm.tag', {
      tags: { retained: { order: 0.25 } },
    });
    await setProfileField(home, 'alice', 'org.example.retained', {
      value: 0.5,
    });
    for (const [node, tenant] of [['home', home], ['edge', edge]] as const) {
      await (await (node === 'home' ? store : edgeStore).tenant(
        tenant.serverName,
      )).tx((conn) =>
        activateTenantAuthority(conn, {
          node,
          incarnation: node + '-store',
          homeIncarnation: 'home-store',
          edgeNode: 'edge',
          edgeIncarnation: 'edge-store',
        })
      );
    }
    const db = await store.tenant(home.serverName);
    const news = await db.query(
      "SELECT * FROM counters WHERE name IN ('account_data','push_rules') ORDER BY name",
    );
    const capture = () =>
      db.tx(async (conn) => [
        ...await captureAccountDataOperations(conn, 'alice'),
        ...await captureProfileOperations(conn, 'alice'),
        ...await capturePushRuleOperations(conn, 'alice', home.serverName),
      ]);
    const operations = await capture();
    assertEquals(operations.map((op) => op.kind).sort(), [
      'account-data',
      'profile',
      'push-rules',
      'tags',
    ]);
    assertEquals(await capture(), operations);
    assertEquals(
      await db.query(
        "SELECT * FROM counters WHERE name IN ('account_data','push_rules') ORDER BY name",
      ),
      news,
    );
    const before = await home.tx((tx) => tx.profiles.get('alice'));
    await setProfileField(home, 'alice', 'displayname', 'New Alice');
    const changed = await capture();
    assertEquals(changed.filter((op) => op.kind === 'profile').length, 2);
    assertEquals(
      changed.find((op) => op.kind === 'profile' && op.sequence === 1),
      operations.find((op) => op.kind === 'profile'),
    );
    for (const op of changed) {
      await edge.tx((tx) =>
        op.kind === 'profile'
          ? tx.profiles.import(op)
          : op.kind === 'push-rules'
          ? tx.pushRules.import(op)
          : tx.accountData.import(op)
      );
    }
    assertEquals(await edge.tx((tx) => tx.profiles.get('alice')), {
      ...before,
      displayname: 'New Alice',
    });
    assertEquals(
      await getAccountData(edge, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'retained-secret', fractional: 0.125 },
    );
    assertEquals(
      await getAccountData(edge, 'alice', '!old:logical.test', 'm.tag'),
      { tags: { retained: { order: 0.25 } } },
    );
    await assertRejects(
      () =>
        (edgeStore.tenant(edge.serverName)).then((db) =>
          db.tx((conn) => captureProfileOperations(conn, 'alice'))
        ),
      Error,
      'requires home authority',
    );
    await assertRejects(() =>
      db.tx((conn) => captureAccountDataOperations(conn, 'missing'))
    );
  } finally {
    await store.close();
    await edgeStore.close();
    await Deno.remove(dir, { recursive: true });
  }
});
