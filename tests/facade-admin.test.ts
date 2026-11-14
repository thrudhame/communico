import { assert, assertEquals } from '@std/assert';
import { facadeOperations } from '#root/api/admin/facade.ts';
import { operationHandler } from '#root/api/admin/handler.ts';
import { startAdminHandler } from '#root/api/admin/socket.ts';
import { adminCall } from '#tests/admin-client.ts';
import { initializeNode, readProtectedFile } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';

Deno.test('pair/initialize/accept/status/revoke stay on protected local sockets without an edge tenant', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-admin-' });
  const cfg = (name: string) => ({
    dir: dir + '/' + name,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  const home = await openStore(cfg('home'), {
    schemas: { server: serverSchema, tenant: tenantSchema },
  });
  const edge = await openStore(cfg('edge'), {
    schemas: { server: serverSchema, tenant: tenantSchema },
  });
  const tenant = await openTenant(home, 'logical.test', { create: true });
  const homePin = 'a'.repeat(64), facadePin = 'b'.repeat(64);
  const hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    homePin,
  );
  let fp: Pairings | undefined;
  const hs = await startAdminHandler(
    operationHandler(facadeOperations({
      role: 'home',
      pairings: () => Promise.resolve(hp),
    })),
    dir + '/home.sock',
  );
  const es = await startAdminHandler(
    operationHandler(facadeOperations({
      role: 'facade',
      async initialize() {
        const node = await initializeNode(
          await edge.server(),
          'logical.test',
          'edge_a',
        );
        fp = new Pairings(
          await edge.server(),
          node.signer(),
          node.publicKey,
          facadePin,
          node,
        );
        return {
          node: node.node,
          incarnation: node.incarnation,
          keyId: node.keyId,
          publicKey: node.publicKey,
        };
      },
      pairings: () => {
        if (!fp) throw new Error('initialize first');
        return Promise.resolve(fp);
      },
    })),
    dir + '/edge.sock',
  );
  try {
    assertEquals((await Deno.lstat(es.path)).mode! & 0o7777, 0o600);
    const initialized = await adminCall(es.path, 'facade/initialize');
    assertEquals(initialized.status, 200);
    assertEquals(initialized.body.result.node, 'edge_a');
    const bundlefile = dir + '/pair.json';
    const paired = await adminCall(hs.path, 'facade/pair', {
      node: 'edge_a',
      url: 'https://edge.test',
      facadePin,
      expires: Date.now() + 60000,
      bundlefile,
    });
    assertEquals(paired.status, 200);
    const bundle = JSON.parse(await readProtectedFile(bundlefile));
    assert(!JSON.stringify(paired.body).includes(bundle.secret));
    assertEquals(
      (await adminCall(es.path, 'facade/accept', { bundlefile })).status,
      200,
    );
    assertEquals(await edge.tenants(), []);
    const status = await adminCall(es.path, 'facade/status');
    assertEquals(status.body.result[0].state, 'pending');
    assert(!JSON.stringify(status.body).includes(bundle.secret));
    assertEquals((await adminCall(es.path, 'facade/pair', {})).status, 404);
    assertEquals((await adminCall(hs.path, 'facade/accept', {})).status, 404);
    const revoked = await adminCall(hs.path, 'facade/revoke', {
      id: bundle.id,
    });
    assertEquals(revoked.status, 200);
    assertEquals(
      (await adminCall(hs.path, 'facade/status')).body.result[0].state,
      'revoked',
    );
    const preserved = await readProtectedFile(bundlefile);
    const overwrite = await adminCall(hs.path, 'facade/pair', {
      node: 'edge_a',
      url: 'https://edge.test',
      facadePin,
      expires: Date.now() + 60000,
      bundlefile,
    });
    assertEquals(overwrite.status, 400);
    assertEquals(await readProtectedFile(bundlefile), preserved);
    assertEquals(
      (await adminCall(hs.path, 'facade/status')).body.result.every((
        row: { state: string },
      ) => row.state === 'revoked'),
      true,
    );
  } finally {
    await hs.shutdown();
    await es.shutdown();
    await home.close();
    await edge.close();
    await Deno.remove(dir, { recursive: true });
  }
});
