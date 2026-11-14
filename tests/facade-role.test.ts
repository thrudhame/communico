import { assertEquals, assertRejects } from '@std/assert';
import { bindRole } from '#engine/facade/role.ts';
import { capabilities } from '#engine/facade/capabilities.ts';
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

Deno.test('one F1 capability manifest gates public requests before auth and excludes home workers', async () => {
  const home = capabilities('home');
  const facade = capabilities('facade');
  for (
    const name of [
      'push',
      'delayed',
      'media',
      'device-lists',
      'link-client',
      'federation-sender',
    ]
  ) {
    assertEquals(facade.service(name), false);
    assertEquals(home.service(name), true);
  }
  assertEquals(facade.service('link-server'), true);
  assertEquals(facade.service('link-inbox'), true);
  const request = (path: string, method = 'GET') =>
    new Request('https://logical.test' + path, { method });
  const ready = () => true;
  const missing = () => false;
  for (
    const path of [
      '/_matrix/federation/v1/event/%24event',
      '/_matrix/key/v2/server',
      '/.well-known/matrix/server',
      '/_matrix/client/versions',
    ]
  ) {
    assertEquals(facade.gate(request(path), missing)?.status, 503);
    assertEquals(facade.gate(request(path), ready), null);
  }
  assertEquals(
    facade.gate(request('/_matrix/federation/v1/event/x', 'POST'), ready)
      ?.status,
    405,
  );
  for (
    const [path, method] of [
      ['/_matrix/client/v3/sync', 'GET'],
      ['/_matrix/client/v3/register', 'POST'],
      ['/_matrix/federation/v1/make_join/room/user', 'GET'],
      ['/_matrix/federation/v1/user/keys/claim', 'POST'],
      ['/_matrix/federation/v1/query/arbitrary', 'GET'],
      ['/_matrix/media/v3/upload', 'POST'],
      ['/v1/facade/initialize', 'POST'],
    ]
  ) {
    assertEquals(facade.gate(request(path, method), ready)?.status, 404);
    assertEquals(home.gate(request(path, method), missing), null);
  }
  const refusal = facade.gate(
    request('/_matrix/client/v3/directory/room/%23alias', 'DELETE'),
    ready,
  )!;
  assertEquals(refusal.status, 503);
  assertEquals(await refusal.json(), {
    errcode: 'M_UNAVAILABLE',
    error: 'operation requires home ingress',
  });
});
