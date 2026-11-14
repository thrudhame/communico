import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';

const homePin = 'a'.repeat(64);
const facadePin = 'b'.repeat(64);
const cfg = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-pairing-' });
  const open = (name: string) =>
    openStore(cfg(dir + '/' + name), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
  let home: Store = await open('home');
  let edge: Store = await open('edge');
  const tenant = await openTenant(home, 'logical.test', { create: true });
  let node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  let hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    homePin,
  );
  let fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    facadePin,
    node,
  );
  return {
    get hp() {
      return hp;
    },
    get fp() {
      return fp;
    },
    get node() {
      return node;
    },
    edge: () => edge,
    home: () => home,
    create: (expires = Date.now() + 60000) =>
      hp.create({
        node: 'edge_a',
        url: 'https://facade.test',
        facadePin,
        expires,
        required: [{ type: 'control', version: 1 }],
      }),
    async reopen() {
      await home.close();
      await edge.close();
      home = await open('home');
      edge = await open('edge');
      const t = await openTenant(home, 'logical.test');
      node = await initializeNode(
        await edge.server(),
        'logical.test',
        'edge_a',
      );
      hp = new Pairings(await home.server(), t.signer(), t.publicB64, homePin);
      fp = new Pairings(
        await edge.server(),
        node.signer(),
        node.publicKey,
        facadePin,
        node,
      );
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('enrollment consumes once and replays exact challenge, grant and receipt across reopen', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await assertRejects(() => f.fp.active(), LinkError, 'not enrolled');
    await f.fp.accept(bundle);
    const transcript = await f.fp.challenge(bundle.id, bundle.secret, homePin);
    await f.reopen();
    assertEquals(
      await f.fp.challenge(bundle.id, bundle.secret, homePin),
      transcript,
    );
    const grant = await f.hp.grant(bundle.id, transcript);
    await f.reopen();
    assertEquals(await f.hp.grant(bundle.id, transcript), grant);
    const receipt = await f.fp.complete(bundle.id, grant, homePin);
    await f.reopen();
    assertEquals(await f.fp.complete(bundle.id, grant, homePin), receipt);
    await f.hp.confirm(bundle.id, receipt);
    await f.hp.confirm(bundle.id, receipt);
    assertEquals(
      (await f.fp.active()).body.transcript.body.incarnation,
      f.node.incarnation,
    );
    assertEquals((await f.hp.status())[0].state, 'paired');
    assertEquals((await f.fp.status())[0].state, 'paired');
    assertEquals(
      await f.edge().tenants(),
      [],
      'enrollment alone cannot provision a Matrix tenant',
    );
    const status = canonicalJson(await f.fp.status());
    assert(!status.includes(bundle.secret));
    assert(!status.includes('private'));
  } finally {
    await f.close();
  }
});

Deno.test('concurrent enrollment retries share one challenge and one monotone grant', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    const transcripts = await Promise.all([
      f.fp.challenge(bundle.id, bundle.secret, homePin),
      f.fp.challenge(bundle.id, bundle.secret, homePin),
    ]);
    assertEquals(transcripts[0], transcripts[1]);
    const grants = await Promise.all([
      f.hp.grant(bundle.id, transcripts[0]),
      f.hp.grant(bundle.id, transcripts[1]),
    ]);
    assertEquals(grants[0], grants[1]);
    const receipts = await Promise.all([
      f.fp.complete(bundle.id, grants[0], homePin),
      f.fp.complete(bundle.id, grants[1], homePin),
    ]);
    assertEquals(receipts[0], receipts[1]);
    const data = await (await f.edge().server()).query(
      'SELECT * FROM facade_pairings',
    );
    assert(!canonicalJson(data).includes(bundle.secret));
    assertEquals(
      await (await f.home().server()).query(
        'SELECT revision FROM facade_control',
      ),
      [{ revision: 1 }],
    );
  } finally {
    await f.close();
  }
});

Deno.test('a new enrollment after retirement cannot revive its older grant or revocation', async () => {
  const f = await fixture();
  try {
    const old = await f.create();
    await f.fp.accept(old);
    const t1 = await f.fp.challenge(old.id, old.secret, homePin);
    const g1 = await f.hp.grant(old.id, t1);
    await f.fp.complete(old.id, g1, homePin);
    const revoked = await f.hp.revoke(old.id);
    await f.fp.retire(revoked, homePin);
    assertEquals(await f.hp.revoke(old.id), revoked);
    const next = await f.create();
    await f.fp.accept(next);
    const t2 = await f.fp.challenge(next.id, next.secret, homePin);
    const g2 = await f.hp.grant(next.id, t2);
    await f.fp.complete(next.id, g2, homePin);
    await f.fp.retire(revoked, homePin);
    assertEquals(await f.fp.active(), g2);
    assert(g2.body.revision > revoked.body.revision);
    await assertRejects(() => f.fp.complete(old.id, g1, homePin), LinkError);
    await assertRejects(() =>
      f.hp.confirm(next.id, {
        body: {
          kind: 'facade-enrollment-receipt',
          pairing: next.id,
          grantHash: 'wrong',
        },
        signature: t2.signature,
      }), LinkError);
  } finally {
    await f.close();
  }
});

Deno.test('restart validates the complete grant against the existing local signer and receipt', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    const transcript = await f.fp.challenge(bundle.id, bundle.secret, homePin);
    const grant = await f.hp.grant(bundle.id, transcript);
    await f.fp.complete(bundle.id, grant, homePin);
    await f.reopen();
    assertEquals(await f.fp.active(), grant);
    const db = await f.edge().server();
    await db.execute('UPDATE facade_pairings SET grant_json=? WHERE id=?', [
      canonicalJson({
        ...grant,
        body: { ...grant.body, revision: grant.body.revision + 1 },
      }),
      bundle.id,
    ]);
    await assertRejects(() => f.fp.active(), LinkError);
    assertEquals(await f.edge().tenants(), []);
    await db.execute(
      'UPDATE facade_pairings SET grant_json=?,receipt_json=NULL WHERE id=?',
      [canonicalJson(grant), bundle.id],
    );
    await assertRejects(() => f.fp.active(), LinkError);
  } finally {
    await f.close();
  }
});

Deno.test('only completed enrollment explicitly provisions the same logical name and node signer', async () => {
  const f = await fixture();
  try {
    await assertRejects(
      () => enrolledTenant(f.edge(), f.fp, 'logical.test', 'edge_a'),
      LinkError,
    );
    assertEquals(await f.edge().tenants(), []);
    const bundle = await f.create();
    await f.fp.accept(bundle);
    const transcript = await f.fp.challenge(bundle.id, bundle.secret, homePin);
    const grant = await f.hp.grant(bundle.id, transcript);
    await f.fp.complete(bundle.id, grant, homePin);
    let tenant = await enrolledTenant(f.edge(), f.fp, 'logical.test', 'edge_a');
    assertEquals(tenant.serverName, 'logical.test');
    assertEquals(tenant.keyId, f.node.keyId);
    assertEquals(tenant.publicB64, f.node.publicKey);
    assertEquals(
      await tenant.signer().sign('proof'),
      await f.node.signer().sign('proof'),
    );
    await f.reopen();
    tenant = await enrolledTenant(f.edge(), f.fp, 'logical.test', 'edge_a');
    assertEquals(tenant.publicB64, f.node.publicKey);
    const db = await f.edge().tenant('logical.test');
    await db.execute("UPDATE tenant SET key_id='wrong'");
    await assertRejects(
      () => enrolledTenant(f.edge(), f.fp, 'logical.test', 'edge_a'),
      Error,
      'identity',
    );
    assertEquals(
      (await db.query('SELECT key_id FROM tenant'))[0].key_id,
      'wrong',
    );
  } finally {
    await f.close();
  }
});

Deno.test('enrollment refuses wrong credentials, pins, node identity, expiry and unsupported protocol', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    for (
      const changes of [
        { node: 'edge_b' },
        { server: 'other.test' },
        { facadePin: homePin },
        { expires: Date.now() - 1 },
        { protocol: { major: 2, minor: 0 } },
      ]
    ) {
      await assertRejects(
        () => f.fp.accept({ ...bundle, ...changes }),
        LinkError,
      );
    }
    await f.fp.accept(bundle);
    await assertRejects(
      () => f.fp.challenge(bundle.id, 'wrong', homePin),
      LinkError,
    );
    await assertRejects(
      () => f.fp.challenge(bundle.id, bundle.secret, facadePin),
      LinkError,
    );
    const transcript = await f.fp.challenge(bundle.id, bundle.secret, homePin);
    await assertRejects(() =>
      f.hp.grant(bundle.id, {
        ...transcript,
        body: { ...transcript.body, incarnation: 'substituted' },
      }), LinkError);
    const grant = await f.hp.grant(bundle.id, transcript);
    await assertRejects(() =>
      f.fp.complete(bundle.id, {
        ...grant,
        body: { ...grant.body, revision: grant.body.revision + 1 },
      }, homePin), LinkError);
    await assertRejects(
      () => f.fp.complete(bundle.id, grant, facadePin),
      LinkError,
    );
    assertEquals((await f.fp.status())[0].state, 'pending');
  } finally {
    await f.close();
  }
});

Deno.test('enrollment fences collisions, revoked authority and delayed pending handshakes', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await assertRejects(() => f.create(), LinkError, 'already');
    await f.fp.accept(bundle);
    await f.fp.accept(bundle);
    await assertRejects(
      () => f.fp.accept({ ...bundle, secret: 'changed' }),
      LinkError,
    );
    const transcript = await f.fp.challenge(bundle.id, bundle.secret, homePin);
    const grant = await f.hp.grant(bundle.id, transcript);
    const receipt = await f.fp.complete(bundle.id, grant, homePin);
    await f.hp.confirm(bundle.id, receipt);
    const revocation = await f.hp.revoke(bundle.id);
    assert(revocation.body.revision > grant.body.revision);
    await assertRejects(
      () => f.hp.grant(bundle.id, transcript),
      LinkError,
      'revoked',
    );
    await f.fp.retire(revocation, homePin);
    await f.reopen();
    await assertRejects(() => f.fp.active(), LinkError, 'not enrolled');
    await assertRejects(
      () => f.fp.complete(bundle.id, grant, homePin),
      LinkError,
      'revoked',
    );
  } finally {
    await f.close();
  }
});

Deno.test('pending expiration uses the supplied admission clock without an invented outage cutoff', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await assertRejects(
      () => f.fp.challenge(bundle.id, bundle.secret, homePin, bundle.expires),
      LinkError,
      'expired',
    );
    const transcript = await f.fp.challenge(
      bundle.id,
      bundle.secret,
      homePin,
      bundle.expires - 1,
    );
    const grant = await f.hp.grant(bundle.id, transcript, bundle.expires - 1);
    const receipt = await f.fp.complete(
      bundle.id,
      grant,
      homePin,
      bundle.expires - 1,
    );
    // Lost completion replies remain replayable after enrollment expiration.
    assertEquals(
      await f.fp.complete(bundle.id, grant, homePin, bundle.expires + 1),
      receipt,
    );
    assertEquals(await f.fp.active(), grant);
  } finally {
    await f.close();
  }
});
