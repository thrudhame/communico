import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { getPublicProfile, setProfileField } from '#engine/tenant/profiles.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { registerOperations } from '#engine/facade/registers.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-profiles-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const store = await openStore(options, { schemas: { tenant: tenantSchema } });
  const home = await openTenant(store, 'home.test', { create: true });
  const edge = await openTenant(store, 'edge.test', { create: true });
  for (const [tenant, node] of [[home, 'home'], [edge, 'edge']] as const) {
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await (await store.tenant(tenant.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
  }
  return {
    dir,
    options,
    store,
    home,
    edge,
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('facade profiles: ordinary field writes retain complete immutable profile intent at the owner', async () => {
  const f = await fixture();
  try {
    await setProfileField(f.home, 'alice', 'org.example.secret', {
      opaque: 'retained',
    });
    const rows = await (await f.store.tenant(f.home.serverName)).tx((conn) =>
      registerOperations(conn, JSON.stringify(['profile', 'alice']))
    );
    assert(
      rows.length > 0,
      'ordinary profile write lost its immutable semantic intent',
    );
    const complete = JSON.parse(rows.at(-1)!.payload);
    assertEquals(complete['org.example.secret'], { opaque: 'retained' });
    assert(Object.hasOwn(complete, 'displayname'));
  } finally {
    await f.close();
  }
});

Deno.test('facade profiles: concurrent individually valid large edits select one complete profile, not an invalid union', async () => {
  const f = await fixture();
  try {
    await setProfileField(f.home, 'alice', 'displayname', 'Baseline');
    for (const op of await f.home.tx((tx) => tx.profiles.operations('alice'))) {
      await f.edge.tx((tx) => tx.profiles.import(op));
    }
    await setProfileField(
      f.home,
      'alice',
      'org.example.home',
      'h'.repeat(40960),
    );
    await setProfileField(
      f.edge,
      'alice',
      'org.example.edge',
      'e'.repeat(40960),
    );
    const a = await f.home.tx((tx) => tx.profiles.operations('alice'));
    const b = await f.edge.tx((tx) => tx.profiles.operations('alice'));
    for (const op of b) await f.home.tx((tx) => tx.profiles.import(op));
    for (const op of a.toReversed()) {
      await f.edge.tx((tx) => tx.profiles.import(op));
    }
    const winner = await getPublicProfile(f.home, 'alice');
    assertEquals(await getPublicProfile(f.edge, 'alice'), winner);
    assert(new TextEncoder().encode(JSON.stringify(winner)).length < 65536);
    assertEquals(Object.hasOwn(winner!, 'org.example.home'), true);
    assertEquals(Object.hasOwn(winner!, 'org.example.edge'), false);
    const before = await f.edge.tx((tx) => tx.profiles.operations('alice'));
    assert(before.some((op) => op.payload.includes('e'.repeat(100))));
    // The next ordinary write observes both complete alternatives, including
    // the losing opaque custom field, and can intentionally restore it.
    await setProfileField(f.edge, 'alice', 'org.example.home', undefined);
    await setProfileField(f.edge, 'alice', 'org.example.edge', 'restored');
    const all = await f.edge.tx((tx) => tx.profiles.operations('alice'));
    assertEquals(all.length, before.length + 2);
    for (const op of all) await f.home.tx((tx) => tx.profiles.import(op));
    assertEquals(await getPublicProfile(f.home, 'alice'), {
      displayname: 'Baseline',
      'org.example.edge': 'restored',
    });
    await f.store.close();
    const cold = await openStore(f.options, {
      schemas: { tenant: tenantSchema },
    });
    try {
      const tenant = await openTenant(cold, 'home.test');
      assertEquals(await getPublicProfile(tenant, 'alice'), {
        displayname: 'Baseline',
        'org.example.edge': 'restored',
      });
      assertEquals(
        (await tenant.tx((tx) => tx.profiles.operations('alice'))).length,
        all.length,
      );
    } finally {
      await cold.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('facade profiles: imports preserve home baseline, validate source and total size, and cannot resurrect deactivated fields', async () => {
  const f = await fixture();
  try {
    await setProfileField(f.home, 'alice', 'displayname', 'Home baseline');
    const baseline = await f.home.tx((tx) => tx.profiles.operations('alice'));
    for (const op of baseline) await f.edge.tx((tx) => tx.profiles.import(op));
    await setProfileField(f.edge, 'alice', 'displayname', 'Edge edit');
    const operation = (await f.edge.tx((tx) => tx.profiles.operations('alice')))
      .find((op) => op.source === 'edge')!;
    await f.home.tx((tx) => tx.profiles.import(operation));
    assertEquals(
      (await getPublicProfile(f.home, 'alice'))?.displayname,
      'Edge edit',
    );
    const count = (await f.home.tx((tx) =>
      tx.profiles.operations('alice')
    )).length;
    await assertRejects(() =>
      f.home.tx((tx) => tx.profiles.import({ ...operation, source: 'foreign' }))
    );
    await assertRejects(() =>
      setProfileField(f.home, 'alice', 'org.example.large', 'x'.repeat(65536))
    );
    assertEquals(
      (await f.home.tx((tx) => tx.profiles.operations('alice'))).length,
      count,
    );
    const db = await f.store.tenant(f.home.serverName);
    await db.execute(
      "UPDATE users SET deactivated=1,display_name=NULL,avatar_url=NULL WHERE localpart='alice'",
    );
    await db.execute("DELETE FROM profile_fields WHERE localpart='alice'");
    await f.home.tx((tx) => tx.profiles.import(operation));
    assertEquals(await getPublicProfile(f.home, 'alice'), {});
    await assertRejects(() =>
      setProfileField(f.home, 'alice', 'displayname', 'resurrection')
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade profiles: passive F1 snapshots cannot overwrite a mutable F2 profile or author an export echo', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.home.tx((tx) =>
      tx.publicReplica.export('alice', 'logical.test')
    );
    const target = await openTenant(f.store, 'snapshot.test', { create: true });
    await target.tx((tx) => tx.publicReplica.install(snapshot, 'logical.test'));
    assertEquals(await target.tx((tx) => tx.profiles.operations('alice')), []);
    await (await f.store.tenant(target.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node: 'edge',
        incarnation: 'edge-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
    await setProfileField(f.home, 'alice', 'displayname', 'Causal winner');
    for (const op of await f.home.tx((tx) => tx.profiles.operations('alice'))) {
      await target.tx((tx) => tx.profiles.import(op));
    }
    const before = await target.tx((tx) => tx.profiles.operations('alice'));
    await target.tx((tx) =>
      tx.publicReplica.install({
        ...snapshot,
        cut: snapshot.cut + 1,
        profile: { displayname: 'Obsolete F1 value' },
      }, 'logical.test')
    );
    assertEquals(
      (await getPublicProfile(target, 'alice'))?.displayname,
      'Causal winner',
    );
    assertEquals(
      await target.tx((tx) => tx.profiles.operations('alice')),
      before,
    );
    await target.tx((tx) =>
      tx.publicReplica.install({
        ...snapshot,
        cut: snapshot.cut + 2,
        deactivated: true,
      }, 'logical.test')
    );
    assertEquals(await getPublicProfile(target, 'alice'), {});
  } finally {
    await f.close();
  }
});
