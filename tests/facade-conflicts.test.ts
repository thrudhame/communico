import { assert, assertEquals } from '@std/assert';
import {
  facadeOperations,
  homeFacadeOperations,
} from '#root/api/admin/facade.ts';
import { operationHandler } from '#root/api/admin/handler.ts';
import { startAdminHandler } from '#root/api/admin/socket.ts';
import { adminCall } from '#tests/admin-client.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { activateTenantAuthority } from '#engine/tenant/session-authority.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { getAccountData, putAccountData } from '#engine/tenant/accountdata.ts';
import { getPublicProfile, setProfileField } from '#engine/tenant/profiles.ts';
import { putRule, rulesetFor } from '#engine/tenant/pushrules.ts';
import { startHttp } from '#tests/http-app.ts';
import { serverSchema } from '#engine/server/schema.ts';

Deno.test('facade conflicts: protected inspection is metadata-only; explicit exports retain complete opaque alternatives without mutating winners', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-conflicts-' });
  const settings = (node: string) => ({
    dir: dir + '/' + node,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const store = await openStore(settings('home'), {
    schemas: { tenant: tenantSchema },
  });
  const edgeStore = await openStore(settings('edge'), {
    schemas: { tenant: tenantSchema },
  });
  const home = await openTenant(store, 'logical.test', { create: true });
  const edge = await openTenant(edgeStore, 'logical.test', { create: true });
  for (
    const [tenant, node, owner] of [[home, 'home', store], [
      edge,
      'edge',
      edgeStore,
    ]] as const
  ) {
    await registerUser(tenant, { localpart: 'alice', password: 'pw' });
    await registerUser(tenant, { localpart: 'bob', password: 'pw' });
    await (await owner.tenant(tenant.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
  }
  // Extra dependencies are ignored by the old implementation, so its missing
  // recovery surface is a behavioral 404, not a missing-API/typecheck failure.
  const deps = {
    role: 'home' as const,
    tenant: () => Promise.resolve(home),
    pairings: () => {
      throw new Error('conflicts must not initialize TLS/pairing');
    },
    status: () => Promise.resolve({ state: 'offline' }),
  };
  const admin = await startAdminHandler(
    operationHandler(facadeOperations(deps)),
    dir + '/admin.sock',
  );
  const secret = 'DO-NOT-PRINT-OPAQUE-CIPHERTEXT';
  try {
    // The complete push baseline is shared before the concurrent revisions.
    await home.tx((tx) => tx.pushRules.prepare('alice'));
    for (const op of await home.tx((tx) => tx.pushRules.operations('alice'))) {
      await edge.tx((tx) => tx.pushRules.import(op));
    }
    await setProfileField(home, 'alice', 'displayname', 'Baseline');
    for (const op of await home.tx((tx) => tx.profiles.operations('alice'))) {
      await edge.tx((tx) => tx.profiles.import(op));
    }
    for (const [tenant, node] of [[home, 'home'], [edge, 'edge']] as const) {
      await putAccountData(tenant, 'alice', '', 'm.secret_storage.key', {
        ciphertext: secret + node,
      });
      await setProfileField(tenant, 'alice', 'org.example.opaque', {
        ciphertext: secret + node,
      });
      await putRule(tenant, 'alice', 'override', secret + node, {
        actions: ['notify'],
        conditions: [],
      }, {});
    }
    for (
      const op of await edge.tx((tx) => tx.accountData.operations('alice'))
    ) {
      await home.tx((tx) => tx.accountData.import(op));
    }
    for (const op of await edge.tx((tx) => tx.profiles.operations('alice'))) {
      await home.tx((tx) => tx.profiles.import(op));
    }
    for (const op of await edge.tx((tx) => tx.pushRules.operations('alice'))) {
      await home.tx((tx) => tx.pushRules.import(op));
    }
    const before = {
      account: await getAccountData(home, 'alice', '', 'm.secret_storage.key'),
      profile: await getPublicProfile(home, 'alice'),
      rules: await rulesetFor(home, 'alice'),
      streams: await home.tx((tx) => tx.streams.heads()),
    };
    assertEquals((await Deno.lstat(admin.path)).mode! & 0o7777, 0o600);
    for (const kind of ['account-data', 'profile', 'push-rules']) {
      const selector = {
        kind,
        localpart: 'alice',
        ...(kind === 'account-data'
          ? { roomId: '', type: 'm.secret_storage.key' }
          : {}),
      };
      const inspected = await adminCall(
        admin.path,
        'facade/conflicts',
        selector,
      );
      assertEquals(
        inspected.status,
        200,
        'retained losing values must be recoverable',
      );
      const view = inspected.body.result;
      assert(!JSON.stringify(inspected.body).includes(secret));
      const loser = view.alternatives.find((row: { source: string }) =>
        row.source === 'edge'
      );
      assert(loser);
      assertEquals(loser.state, 'concurrent');
      const exportfile = dir + '/' + kind + '.json';
      const exported = await adminCall(admin.path, 'facade/conflicts/export', {
        ...selector,
        operationId: loser.operationId,
        exportfile,
      });
      assertEquals(exported.status, 200);
      assert(!JSON.stringify(exported.body).includes(secret));
      assertEquals((await Deno.lstat(exportfile)).mode! & 0o7777, 0o600);
      const bytes = await Deno.readTextFile(exportfile),
        saved = JSON.parse(bytes);
      assertEquals(saved.operation.operationId, loser.operationId);
      assertEquals(saved.operation.payloadHash, loser.payloadHash);
      assert(bytes.includes(secret + 'edge'));
      assertEquals(saved.selector, selector);
      assertEquals(
        (await adminCall(admin.path, 'facade/conflicts/export', {
          ...selector,
          operationId: loser.operationId,
          exportfile,
        })).status,
        400,
      );
      assertEquals(await Deno.readTextFile(exportfile), bytes);
      assertEquals(
        (await adminCall(admin.path, 'facade/conflicts/export', {
          ...selector,
          operationId: view.winner,
          exportfile: dir + '/winner-' + kind,
        })).status,
        404,
      );
      assertEquals(
        (await adminCall(admin.path, 'facade/conflicts/export', {
          ...selector,
          localpart: 'bob',
          operationId: loser.operationId,
          exportfile: dir + '/wrong-' + kind,
        })).status,
        404,
      );
      const symlink = dir + '/symlink-' + kind;
      await Deno.symlink(exportfile, symlink);
      assertEquals(
        (await adminCall(admin.path, 'facade/conflicts/export', {
          ...selector,
          operationId: loser.operationId,
          exportfile: symlink,
        })).status,
        400,
      );
      assertEquals(await Deno.readTextFile(exportfile), bytes);
    }
    assertEquals({
      account: await getAccountData(home, 'alice', '', 'm.secret_storage.key'),
      profile: await getPublicProfile(home, 'alice'),
      rules: await rulesetFor(home, 'alice'),
      streams: await home.tx((tx) => tx.streams.heads()),
    }, before);
    assert(
      !JSON.stringify((await adminCall(admin.path, 'facade/status')).body)
        .includes(secret),
    );
    assertEquals(
      (await adminCall(admin.path, 'facade/conflicts', {
        kind: 'credentials',
        localpart: 'alice',
      })).status,
      400,
    );
    // Recovery is a new normal owner write, not an administrator replacing rows
    // or importing an old operation as a newly dominant value.
    const recovered = JSON.parse(
      await Deno.readTextFile(dir + '/account-data.json'),
    );
    await putAccountData(
      home,
      'alice',
      '',
      'm.secret_storage.key',
      JSON.parse(recovered.operation.payload),
    );
    assertEquals(
      await getAccountData(home, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: secret + 'edge' },
    );
    const history = await adminCall(admin.path, 'facade/conflicts', {
      kind: 'account-data',
      localpart: 'alice',
      roomId: '',
      type: 'm.secret_storage.key',
    });
    assert(
      history.body.result.alternatives.every((row: { state: string }) =>
        row.state === 'superseded'
      ),
    );
    // A facade without a granted tenant still has status, but no private data.
    const noTenant = {
      ...deps,
      role: 'facade' as const,
      tenant: () => Promise.resolve(null),
    };
    const unavailable = operationHandler(facadeOperations(noTenant));
    assertEquals(
      (await unavailable(
        new Request('http://admin/v1/facade/conflicts', {
          method: 'POST',
          body: JSON.stringify({ kind: 'profile', localpart: 'alice' }),
        }),
      )).status,
      503,
    );
  } finally {
    await admin.shutdown();
    await store.close();
    await edgeStore.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('facade conflicts: exported ciphertext recovers through an ordinary own-user authenticated PUT and sync, never a public admin route', async () => {
  const http = await startHttp();
  const dir = await Deno.makeTempDir({ prefix: 'facade-recovery-' });
  const edgeStore = await openStore({
    dir: dir + '/edge',
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = http.app.tenant;
  const edge = await openTenant(edgeStore, home.serverName, { create: true });
  const alice = await http.registerTestUser('alice', 'pw');
  const bob = await http.registerTestUser('bob', 'pw');
  await registerUser(edge, { localpart: 'alice', password: 'pw' });
  for (
    const [owner, node] of [[http.app.store, 'home'], [
      edgeStore,
      'edge',
    ]] as const
  ) {
    await (await owner.tenant(home.serverName)).tx((conn) =>
      activateTenantAuthority(conn, {
        node,
        incarnation: node + '-store',
        homeIncarnation: 'home-store',
        edgeNode: 'edge',
        edgeIncarnation: 'edge-store',
      })
    );
  }
  const admin = await startAdminHandler(
    operationHandler(homeFacadeOperations(http.app)),
    dir + '/admin.sock',
  );
  const call = (path: string, method: string, body?: unknown, token?: string) =>
    http.matrix(
      new Request('http://x' + path, {
        method,
        headers: token ? { Authorization: 'Bearer ' + token } : {},
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    const type = 'm.secret_storage.key.test';
    const payload = {
      ciphertext: 'opaque-recovery',
      mac: 'unchanged',
      iv: 'unchanged',
    };
    await putAccountData(home, 'alice', '', type, {
      ciphertext: 'home-winner',
    });
    await putAccountData(edge, 'alice', '', type, payload);
    const [loser] = await edge.tx((tx) => tx.accountData.operations('alice'));
    await home.tx((tx) => tx.accountData.import(loser));
    const exportfile = dir + '/recovered.json';
    assertEquals(
      (await adminCall(admin.path, 'facade/conflicts/export', {
        kind: 'account-data',
        localpart: 'alice',
        roomId: '',
        type,
        operationId: loser.operationId,
        exportfile,
      })).status,
      200,
    );
    const saved = JSON.parse(await Deno.readTextFile(exportfile));
    const url = '/_matrix/client/v3/user/' +
      encodeURIComponent(alice.user_id!) + '/account_data/' + type;
    assertEquals(
      (await call(url, 'PUT', JSON.parse(saved.operation.payload))).status,
      401,
    );
    assertEquals(
      (await call(
        url,
        'PUT',
        JSON.parse(saved.operation.payload),
        bob.access_token,
      )).status,
      403,
    );
    assertEquals(
      (await call(
        url,
        'PUT',
        JSON.parse(saved.operation.payload),
        alice.access_token,
      )).status,
      200,
    );
    const read = await call(url, 'GET', undefined, alice.access_token);
    assertEquals(read.status, 200);
    assertEquals(await read.json(), payload);
    const sync = await call(
      '/_matrix/client/v3/sync?timeout=0',
      'GET',
      undefined,
      alice.access_token,
    );
    assertEquals(sync.status, 200);
    const response = await sync.json();
    assertEquals(
      response.account_data.events.find((row: { type: string }) =>
        row.type === type
      ).content,
      payload,
    );
    assertEquals(
      (await call(
        '/v1/facade/conflicts/export',
        'POST',
        {},
        alice.access_token,
      )).status,
      404,
    );
    const operations = await home.tx((tx) =>
      tx.accountData.operations('alice')
    );
    assertEquals(operations.length, 3);
    assertEquals(
      JSON.parse(
        operations.find((op) => op.source === 'home' && op.sequence === 2)!
          .payload,
      ),
      payload,
    );
  } finally {
    await admin.shutdown();
    await edgeStore.close();
    await http.close();
    await Deno.remove(dir, { recursive: true });
  }
});
