import { assertEquals, assertRejects } from '@std/assert';
import { initializeNode } from '#engine/facade/identity.ts';
import { enrollLink, enrollmentHandler } from '#engine/facade/link.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
} from '#engine/facade/protocol.ts';
import { LinkClient, startLinkTransport } from '#engine/facade/transport.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { facadeTls } from './support/facade-tls.ts';

async function fixture() {
  const tls = await facadeTls();
  const open = (side: string) =>
    openStore({
      dir: tls.dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  let home = await open('home');
  let facade = await open('facade');
  let tenant = await openTenant(home, 'logical.test', { create: true });
  let node = await initializeNode(
    await facade.server(),
    'logical.test',
    'edge_a',
  );
  let hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    tls.homePin,
  );
  let fp = new Pairings(
    await facade.server(),
    node.signer(),
    node.publicKey,
    tls.facadePin,
    node,
  );
  let dropReceipt = false;
  let changes = 0;
  const handler = enrollmentHandler({
    server: 'logical.test',
    node: node.node,
    incarnation: node.incarnation,
    pairings: () => Promise.resolve(fp),
    changed: () => {
      changes++;
      return Promise.resolve();
    },
  });
  const transport = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: tls.facade,
    authorize: (pin) => fp.allowsHome(pin),
    handle: async (request, pin) => {
      const response = await handler(request, pin);
      if (dropReceipt && request.url.endsWith('/complete')) {
        dropReceipt = false;
        throw new Error('receipt response lost after durable completion');
      }
      return response;
    },
  });
  return {
    tls,
    get hp() {
      return hp;
    },
    get fp() {
      return fp;
    },
    get changes() {
      return changes;
    },
    dropReceipt() {
      dropReceipt = true;
    },
    create: () =>
      hp.create({
        node: 'edge_a',
        url: transport.url,
        facadePin: tls.facadePin,
        expires: Date.now() + 60000,
        required: [...LINK_CAPABILITIES],
      }),
    client: () =>
      new LinkClient(tls.home, { url: transport.url, pin: tls.facadePin }),
    async reopen() {
      await home.close();
      await facade.close();
      home = await open('home');
      facade = await open('facade');
      tenant = await openTenant(home, 'logical.test');
      node = await initializeNode(
        await facade.server(),
        'logical.test',
        'edge_a',
      );
      hp = new Pairings(
        await home.server(),
        tenant.signer(),
        tenant.publicB64,
        tls.homePin,
      );
      fp = new Pairings(
        await facade.server(),
        node.signer(),
        node.publicKey,
        tls.facadePin,
        node,
      );
    },
    async close() {
      await transport.close();
      await home.close();
      await facade.close();
      await tls.close();
    },
  };
}

Deno.test('home initiates enrollment over pinned mTLS and retries a lost receipt without plaintext credentials', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    assertEquals(await f.fp.allowsHome(f.tls.homePin), false);
    await f.fp.accept(bundle);
    f.dropReceipt();
    await assertRejects(
      () => enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret),
      LinkError,
    );
    const granted = await f.fp.active();
    assertEquals((await f.hp.status())[0].state, 'granting');
    await f.reopen();
    await enrollLink(f.hp, bundle.id, f.tls.home);
    assertEquals((await f.hp.status())[0].state, 'paired');
    assertEquals(await f.fp.active(), granted);
    await enrollLink(f.hp, bundle.id, f.tls.home);
    assertEquals(await f.fp.active(), granted);
    assertEquals(f.changes, 3);
    await f.hp.revoke(bundle.id);
    await enrollLink(f.hp, bundle.id, f.tls.home);
    await f.reopen();
    await enrollLink(f.hp, bundle.id, f.tls.home);
    await assertRejects(() => f.fp.active(), LinkError, 'not enrolled');
    assertEquals((await f.fp.status())[0].state, 'revoked');
  } finally {
    await f.close();
  }
});

Deno.test('enrollment HTTP rejects wrong secrets and protocol skew without granting authority', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await assertRejects(
      () => enrollLink(f.hp, bundle.id, f.tls.home, 'wrong'),
      LinkError,
    );
    await assertRejects(
      () => enrollLink(f.hp, bundle.id, f.tls.home),
      LinkError,
    );
    for (
      const patch of [
        { protocol: { major: 2, minor: 0 } },
        { required: [{ type: 'sql', version: 1 }] },
        { server: 'other.test' },
      ]
    ) {
      const response = await f.client().fetch('/_communico/link/v1/enroll', {
        method: 'POST',
        body: JSON.stringify({
          protocol: LINK_VERSION,
          required: LINK_CAPABILITIES,
          server: 'logical.test',
          source: 'home',
          incarnation: bundle.id,
          pairing: bundle.id,
          secret: bundle.secret,
          ...patch,
        }),
      });
      assertEquals(response.status, patch.server ? 403 : 409);
      await response.body?.cancel();
    }
    assertEquals((await f.hp.status())[0].state, 'pending');
    await assertRejects(() => f.fp.active(), LinkError);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    assertEquals((await f.hp.status())[0].state, 'paired');
  } finally {
    await f.close();
  }
});
