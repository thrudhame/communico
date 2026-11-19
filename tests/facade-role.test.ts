import { assertEquals, assertRejects } from '@std/assert';
import { bindRole } from '#engine/facade/role.ts';
import { capabilities } from '#engine/facade/capabilities.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';

Deno.test('B8 filters mount only their delivered methods through domain admission', async () => {
  const own = '/_matrix/client/v3/user/%40alice%3Alogical.test/filter';
  const f2 = capabilities('facade', 'f2');
  for (const [method, path] of [['POST', own], ['GET', own + '/filter-id']]) {
    const request = new Request('https://facade.test' + path, { method });
    assertEquals(f2.gate(request, () => true), null);
    assertEquals(f2.gate(request, () => false)?.status, 503);
    assertEquals(
      capabilities('facade', 'f1').gate(request, () => true)?.status,
      404,
    );
  }
  const wrong = f2.gate(
    new Request('https://facade.test' + own, { method: 'DELETE' }),
    () => true,
  )!;
  assertEquals(wrong.status, 405);
  assertEquals((await wrong.json()).errcode, 'M_UNRECOGNIZED');
});

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

Deno.test('F2 manifest enables delivered auth, registers and device keys without later capabilities', () => {
  const facade = capabilities('facade', 'f2');
  const request = (path: string, method: string) =>
    new Request('https://logical.test/_matrix/client/' + path, { method });
  for (
    const [path, method] of [
      ['v3/login', 'GET'],
      ['v3/login', 'POST'],
      ['r0/login', 'GET'],
      ['r0/login', 'POST'],
      ['v3/refresh', 'POST'],
      ['v3/logout', 'POST'],
      ['v3/logout/all', 'POST'],
      ['v3/account/whoami', 'GET'],
      ['v3/delete_devices', 'POST'],
      ['v3/account/deactivate', 'POST'],
      ['v3/devices/target', 'DELETE'],
      ['v3/devices/target', 'PUT'],
      ['v3/devices', 'GET'],
      ['v3/devices/target', 'GET'],
      ['v3/keys/upload', 'POST'],
      ['v3/keys/query', 'POST'],
      ['v3/keys/claim', 'POST'],
      ['v3/keys/signatures/upload', 'POST'],
      ['v3/sendToDevice/m.test/txn', 'PUT'],
      ['v3/profile/%40alice%3Atest', 'GET'],
      ['v3/profile/%40alice%3Atest/displayname', 'GET'],
      ['v3/profile/%40alice%3Atest/org.test.field', 'PUT'],
      ['v3/profile/%40alice%3Atest/org.test.field', 'DELETE'],
      ['v3/pushrules/', 'GET'],
      ['v3/pushrules/global/', 'GET'],
      ['v3/pushrules/global/override/rule', 'GET'],
      ['v3/pushrules/global/override/rule', 'PUT'],
      ['v3/pushrules/global/override/rule', 'DELETE'],
      ['v3/pushrules/global/override/rule/actions', 'GET'],
      ['v3/pushrules/global/override/rule/actions', 'PUT'],
      ['v3/pushrules/global/override/rule/enabled', 'GET'],
      ['v3/pushrules/global/override/rule/enabled', 'PUT'],
      ['v3/user/%40alice%3Atest/account_data/m.test', 'GET'],
      ['v3/user/%40alice%3Atest/account_data/m.test', 'PUT'],
      ['v3/user/%40alice%3Atest/rooms/room/account_data/m.test', 'GET'],
      ['v3/user/%40alice%3Atest/rooms/room/account_data/m.test', 'PUT'],
      ['v3/user/%40alice%3Atest/rooms/room/tags', 'GET'],
      ['v3/user/%40alice%3Atest/rooms/room/tags/tag', 'PUT'],
      ['v3/user/%40alice%3Atest/rooms/room/tags/tag', 'DELETE'],
      ['v3/rooms/room/read_markers', 'POST'],
      ['v3/rooms/room/receipt/m.read/event', 'POST'],
      ['v3/user/%40alice%3Atest/filter', 'POST'],
      ['v3/user/%40alice%3Atest/filter/id', 'GET'],
      ['v3/user/%40alice%3Atest/openid/request_token', 'POST'],
      ['v3/users/%40alice%3Atest/report', 'POST'],
      ['v3/rooms/room/report', 'POST'],
      ['v3/rooms/room/forget', 'POST'],
      ['v3/rooms/room/report/event', 'POST'],
    ]
  ) assertEquals(facade.gate(request(path, method), () => true), null);
  for (
    const path of ['register', 'account/password', 'keys/device_signing/upload']
  ) {
    assertEquals(
      facade.gate(request('v3/' + path, 'POST'), () => true)?.status,
      503,
    );
  }
  for (
    const [path, method] of [
      ['v3/sync', 'GET'],
      ['v3/keys/changes', 'GET'],
    ]
  ) assertEquals(facade.gate(request(path, method), () => true)?.status, 404);
  assertEquals(
    facade.gate(request('v3/profile/%40alice%3Atest', 'PUT'), () => true)
      ?.status,
    405,
  );
  assertEquals(facade.service('deactivation'), true);
  assertEquals(facade.service('device-lists'), true);
  assertEquals(facade.service('federation-sender'), true);
  const send = request('v3/sendToDevice/m.room.encrypted/client-txn', 'PUT');
  const scopes: string[] = [];
  assertEquals(
    facade.gate(send, (scope) => {
      scopes.push(scope);
      return true;
    }),
    null,
  );
  assertEquals(scopes, ['auth']);
  assertEquals(facade.gate(send, () => false)?.status, 503);
  assertEquals(
    capabilities('facade', 'f1').gate(send, () => true)?.status,
    404,
  );
  assertEquals(
    facade.gate(request('v3/sendToDevice/m.test/txn', 'POST'), () => true)
      ?.status,
    405,
  );
  assertEquals(
    capabilities('facade', 'f1').service('federation-sender'),
    false,
  );
  assertEquals(
    facade.gate(
      new Request(
        'https://logical.test/_matrix/federation/v1/user/keys/claim',
        { method: 'POST' },
      ),
      () => true,
    ),
    null,
  );
  assertEquals(capabilities('facade', 'f1').service('deactivation'), false);
  const openid = new Request(
    'https://logical.test/_matrix/federation/v1/openid/userinfo',
  );
  assertEquals(facade.gate(openid, () => true), null);
  assertEquals(
    capabilities('facade', 'f1').gate(openid, () => true)?.status,
    404,
  );
  assertEquals(
    facade.gate(new Request(openid.url, { method: 'POST' }), () => true)
      ?.status,
    405,
  );
  for (
    const service of [
      'push',
      'delayed',
      'media',
      'link-client',
    ]
  ) {
    assertEquals(facade.service(service), false);
  }
});

Deno.test('F2 backup manifest enables all replica reads while every write stays home-only', async () => {
  const facade = capabilities('facade', 'f2');
  for (
    const path of [
      'version',
      'version/1',
      'keys',
      'keys/room',
      'keys/room/session',
    ]
  ) {
    const url = 'https://logical.test/_matrix/client/v3/room_keys/' + path;
    assertEquals(facade.gate(new Request(url), () => true), null);
    assertEquals(facade.gate(new Request(url), () => false)?.status, 503);
    assertEquals(
      capabilities('facade', 'f1').gate(new Request(url), () => true)?.status,
      404,
    );
    for (
      const method of path.startsWith('version')
        ? (path === 'version' ? ['POST'] : ['PUT', 'DELETE'])
        : ['PUT', 'DELETE']
    ) {
      const refusal = facade.gate(new Request(url, { method }), () => true)!;
      assertEquals(refusal.status, 503);
      assertEquals(await refusal.json(), {
        errcode: 'M_UNAVAILABLE',
        error: 'operation requires home ingress',
      });
    }
  }
});

Deno.test('F2 room authoring and reads use client scope, not federation availability', () => {
  const facade = capabilities('facade', 'f2');
  const f1 = capabilities('facade', 'f1');
  for (
    const [method, path] of [
      ['POST', 'createRoom'],
      ['PUT', 'rooms/room/send/m.room.encrypted/txn'],
      ['PUT', 'rooms/room/redact/event/txn'],
      ['PUT', 'rooms/room/state/m.room.topic'],
      ['PUT', 'rooms/room/state/m.room.topic/'],
      ['PUT', 'rooms/room/state/m.room.topic/key'],
      ['GET', 'rooms/room/state'],
      ['GET', 'rooms/room/state/m.room.topic'],
      ['GET', 'rooms/room/state/m.room.topic/'],
      ['GET', 'rooms/room/state/m.room.topic/key'],
      ['GET', 'rooms/room/event/event'],
      ['GET', 'rooms/room/context/event'],
      ['GET', 'rooms/room/messages'],
      ['GET', 'rooms/room/members'],
      ['GET', 'rooms/room/joined_members'],
      ['GET', 'rooms/room/initialSync'],
    ]
  ) {
    const request = new Request(
      'https://logical.test/_matrix/client/v3/' + path,
      { method },
    );
    const scopes: string[] = [];
    assertEquals(
      facade.gate(request, (scope) => {
        scopes.push(scope);
        return true;
      }),
      null,
    );
    assertEquals(scopes, ['clientrooms']);
    assertEquals(facade.gate(request, () => false)?.status, 503);
    assertEquals(f1.gate(request, () => true)?.status, 404);
  }
  for (
    const [method, path] of [
      ['GET', 'sync'],
    ]
  ) {
    assertEquals(
      facade.gate(
        new Request('https://logical.test/_matrix/client/v3/' + path, {
          method,
        }),
        () => true,
      )?.status,
      404,
    );
  }
});

Deno.test('F2 membership activates only delivered methods and their independent client/federation scopes', () => {
  const facade = capabilities('facade', 'f2');
  const f1 = capabilities('facade', 'f1');
  const routes: [string, string, string][] = [];
  for (const name of ['make_join', 'make_knock', 'make_leave']) {
    routes.push([
      'GET',
      '/_matrix/federation/v1/' + name + '/room/user',
      'rooms',
    ]);
  }
  for (const name of ['send_join', 'send_knock', 'send_leave']) {
    routes.push([
      'PUT',
      '/_matrix/federation/v1/' + name + '/room/event',
      'rooms',
    ]);
  }
  for (const name of ['send_join', 'send_leave', 'invite']) {
    routes.push([
      'PUT',
      '/_matrix/federation/v2/' + name + '/room/event',
      'rooms',
    ]);
  }
  for (const name of ['join', 'knock']) {
    routes.push([
      'POST',
      '/_matrix/client/v3/' + name + '/room',
      'clientrooms',
    ]);
  }
  for (const name of ['join', 'invite', 'leave', 'kick', 'ban', 'unban']) {
    routes.push([
      'POST',
      '/_matrix/client/v3/rooms/room/' + name,
      'clientrooms',
    ]);
  }
  for (const [method, path, scope] of routes) {
    const request = new Request('https://logical.test' + path, { method });
    const scopes: string[] = [];
    assertEquals(
      facade.gate(request, (required) => {
        scopes.push(required);
        return true;
      }),
      null,
      path,
    );
    assertEquals(scopes, [scope]);
    assertEquals(facade.gate(request, () => false)?.status, 503);
    assertEquals(f1.gate(request, () => true)?.status, 404);
    assertEquals(
      facade.gate(new Request(request.url, { method: 'DELETE' }), () => true)
        ?.status,
      405,
    );
  }
  for (
    const [method, path] of [
      ['PUT', '/_matrix/federation/v1/invite/room/event'],
      ['PUT', '/_matrix/federation/v2/send_knock/room/event'],
      ['PUT', '/_matrix/federation/v1/exchange_third_party_invite/room'],
      ['PUT', '/_matrix/federation/v1/3pid/onbind'],
      ['GET', '/_matrix/federation/v1/make_join/room'],
      ['POST', '/_matrix/client/v3/join/room/extra'],
      ['GET', '/_matrix/client/v3/joined_rooms'],
      ['GET', '/_matrix/client/v3/sync'],
    ]
  ) {
    assertEquals(
      facade.gate(
        new Request('https://logical.test' + path, { method }),
        () => true,
      )?.status,
      404,
      path,
    );
  }
});
