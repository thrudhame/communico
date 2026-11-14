import { assertEquals, assertRejects } from '@std/assert';
import { bindRole } from '#engine/facade/role.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';

Deno.test('runtime identity binds role, server and node before recovery and cannot regenerate a lost signer', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-role-' });
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  const identity = {
    role: 'facade' as const,
    server: 'logical.test',
    node: 'edge_a',
  };
  let store = await openStore(options, {
    schemas: { server: serverSchema, tenant: tenantSchema },
    beforeStartup: (store) => bindRole(store, identity),
  });
  try {
    assertEquals((await bindRole(store, identity)).initialized, false);
    const node = await initializeNode(
      await store.server(),
      identity.server,
      identity.node,
    );
    assertEquals((await bindRole(store, identity)).initialized, true);
    await assertRejects(
      () => bindRole(store, { ...identity, role: 'home' }),
      LinkError,
    );
    await assertRejects(
      () => bindRole(store, { ...identity, node: 'edge_b' }),
      LinkError,
    );
    await assertRejects(
      () => bindRole(store, { ...identity, server: 'another.test' }),
      LinkError,
    );
    await store.close();
    store = await openStore(options, {
      schemas: { server: serverSchema, tenant: tenantSchema },
      beforeStartup: (store) => bindRole(store, identity),
    });
    assertEquals(
      (await initializeNode(
        await store.server(),
        identity.server,
        identity.node,
      )).keyId,
      node.keyId,
    );
    await (await store.server()).execute('DELETE FROM facade_node');
    const db = await store.server();
    await assertRejects(
      () => initializeNode(db, identity.server, identity.node),
      LinkError,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('an existing home tenant cannot be adopted as an independent facade store', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-home-role-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  try {
    await openTenant(store, 'logical.test', { create: true });
    await assertRejects(
      () =>
        bindRole(store, {
          role: 'facade',
          server: 'logical.test',
          node: 'edge_a',
        }),
      LinkError,
    );
    assertEquals(
      (await bindRole(store, {
        role: 'home',
        server: 'logical.test',
        node: '',
      })).role,
      'home',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
