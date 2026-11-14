import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { exportKeyRoster, FacadeKeys } from '#engine/facade/control.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LINK_CAPABILITIES, LinkError } from '#engine/facade/protocol.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-control-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home');
  let edge = await open('edge');
  const tenant = await openTenant(home, 'logical.test', { create: true });
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    'a'.repeat(64),
  );
  let fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  const grant = await hp.grant(
    bundle.id,
    await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
  );
  await hp.confirm(
    bundle.id,
    await fp.complete(bundle.id, grant, 'a'.repeat(64)),
  );
  const journal = () => new Journal(edgeServer, LINK_CAPABILITIES);
  let edgeServer = await edge.server();
  const keys = () =>
    new FacadeKeys(edgeServer, node.signer(), node.publicKey, fp);
  const exportRoster = () => exportKeyRoster(home, tenant, 'edge_a', bundle.id);
  return {
    home,
    tenant,
    node,
    hp,
    bundle,
    keys,
    journal,
    exportRoster,
    async reenroll() {
      await fp.retire(await hp.revoke(bundle.id), 'a'.repeat(64));
      const next = await hp.create({
        node: 'edge_a',
        url: 'https://facade.test',
        facadePin: 'b'.repeat(64),
        expires: Date.now() + 60000,
        required: [...LINK_CAPABILITIES],
      });
      await fp.accept(next);
      const granted = await hp.grant(
        next.id,
        await fp.challenge(next.id, next.secret, 'a'.repeat(64)),
      );
      await hp.confirm(
        next.id,
        await fp.complete(next.id, granted, 'a'.repeat(64)),
      );
      return await exportKeyRoster(home, tenant, 'edge_a', next.id);
    },
    async downgrade() {
      await edgeServer.tx(async (conn) => {
        await conn.exec(
          'DROP TABLE server_key_decisions; DROP TABLE federation_policy; DROP TABLE facade_scopes; DROP TABLE facade_exports; DROP TABLE facade_key_roster',
        );
        await conn.execute("UPDATE meta SET v='28' WHERE k='schema_version'");
      }, { mode: 'deferred' });
    },
    async receive() {
      const record = await exportRoster();
      await journal().receive('home', [record]);
      return record;
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
      edgeServer = await edge.server();
      fp = new Pairings(
        edgeServer,
        node.signer(),
        node.publicKey,
        'b'.repeat(64),
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

Deno.test('approved roster is journaled once, durably applied, and renewed offline with only the facade signature', async () => {
  setConfigForTests({
    federation: { keyvalidityhours: 1 },
    facade: { maxofflinedays: 0 },
  });
  const f = await fixture();
  try {
    await assertRejects(() => f.keys().document(), MatrixError, 'not ready');
    const record = await f.receive();
    assertEquals(await f.exportRoster(), record);
    assertEquals(await f.keys().apply(f.journal(), record), true);
    const verification = f.keys().verificationKeys();
    assertEquals(
      (await verification.getVerifyKey(
        'logical.test',
        f.tenant.keyId,
        Date.now(),
        'event',
      )).algorithm.name,
      'Ed25519',
    );
    await assertRejects(
      () =>
        verification.getVerifyKey(
          'logical.test',
          'ed25519:unknown',
          0,
          'event',
        ),
      UpstreamError,
      'local key unavailable',
    );
    const before = await f.keys().document();
    assertEquals(
      Object.keys(before.verify_keys).sort(),
      [f.tenant.keyId, f.node.keyId].sort(),
    );
    assertEquals(Object.keys(before.signatures['logical.test']), [
      f.node.keyId,
    ]);
    const publicKey = await importPublicKeyFromRaw(
      matrixBase64(f.node.publicKey, 32),
    );
    assert(await verifyJson(before, 'logical.test', f.node.keyId, publicKey));
    await f.reopen();
    assertEquals(await f.keys().apply(f.journal(), record), false);
    assertEquals(await f.keys().document(), before);
    const after = await f.keys().document(before.valid_until_ts - 1000);
    assert(after.valid_until_ts > before.valid_until_ts);
    assertEquals(after.verify_keys, before.verify_keys);
    assert(await verifyJson(after, 'logical.test', f.node.keyId, publicKey));
    assertEquals(
      (await f.journal().heads('home', 'in', record)).applied.sequence,
      1,
    );
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('offline renewal cap preserves old validity, and authenticated contact survives reopen', async () => {
  setConfigForTests({
    federation: { keyvalidityhours: 168 },
    facade: { maxofflinedays: 1 },
  });
  const f = await fixture();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    const now = Date.now();
    await f.keys().contact(now);
    const doc = await f.keys().document(now);
    assertEquals(await f.keys().document(now + 5 * 86400000), doc);
    await assertRejects(
      () => f.keys().document(doc.valid_until_ts),
      MatrixError,
      'expired',
    );
    await f.keys().contact(doc.valid_until_ts);
    await f.reopen();
    assert(
      (await f.keys().document(doc.valid_until_ts)).valid_until_ts >
        doc.valid_until_ts,
    );
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('re-enrollment makes every roster consumer unavailable until its new control cut arrives', async () => {
  const f = await fixture();
  try {
    const first = await f.receive();
    await f.keys().apply(f.journal(), first);
    const prior = await f.keys().document();
    const next = await f.reenroll();
    await assertRejects(() => f.keys().document(), MatrixError, 'not ready');
    assertEquals((await f.keys().status()).ready, false);
    await assertRejects(
      () => f.keys().requestSigner().sign('not yet authorized'),
      MatrixError,
      'not ready',
    );
    await assertRejects(
      () =>
        f.keys().verificationKeys().getVerifyKey(
          'logical.test',
          f.tenant.keyId,
          0,
          'event',
        ),
      UpstreamError,
    );
    await f.reopen();
    await assertRejects(() => f.keys().document(), MatrixError, 'not ready');
    await f.journal().receive('home', [next]);
    await f.keys().apply(f.journal(), next);
    assertEquals((await f.keys().status()).ready, true);
    assertEquals((await f.keys().document()).verify_keys, prior.verify_keys);
  } finally {
    await f.close();
  }
});

Deno.test('facade request signing refuses an expired offline authority before creating a signature', async () => {
  setConfigForTests({
    federation: { keyvalidityhours: 1 },
    facade: { maxofflinedays: 1 },
  });
  const f = await fixture();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    const past = Date.now() - 2 * 86400000;
    await f.keys().contact(past);
    await f.keys().document(past);
    await assertRejects(
      () => f.keys().requestSigner().sign('not signed'),
      MatrixError,
      'expired',
    );
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('roster retirement is preserved, and changed or forged control cannot advance the apply cut', async () => {
  const f = await fixture();
  try {
    const first = await f.receive();
    await f.keys().apply(f.journal(), first);
    // Another approved key is retired without retiring this active node's link.
    const other = await f.hp.create({
      node: 'edge_b',
      url: 'https://other.test',
      facadePin: 'c'.repeat(64),
      expires: Date.now() + 60000,
      required: [...LINK_CAPABILITIES],
    });
    const otherDir = await Deno.makeTempDir({ prefix: 'facade-other-' });
    const otherStore = await openStore({
      dir: otherDir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
    try {
      const node = await initializeNode(
        await otherStore.server(),
        'logical.test',
        'edge_b',
      );
      const pairing = new Pairings(
        await otherStore.server(),
        node.signer(),
        node.publicKey,
        'c'.repeat(64),
        node,
      );
      await pairing.accept(other);
      await f.hp.grant(
        other.id,
        await pairing.challenge(other.id, other.secret, 'a'.repeat(64)),
      );
      const retiredAt = Date.now();
      await f.hp.revoke(other.id, retiredAt);
      const next = await f.receive();
      await f.keys().apply(f.journal(), next);
      const doc = await f.keys().document();
      assertEquals(doc.old_verify_keys?.[node.keyId], {
        key: node.publicKey,
        expired_ts: retiredAt,
      });
      assertEquals(doc.verify_keys[node.keyId], undefined);
      const verification = f.keys().verificationKeys();
      assertEquals(
        (await verification.getVerifyKey(
          'logical.test',
          node.keyId,
          retiredAt,
          'event',
        )).algorithm.name,
        'Ed25519',
      );
      await assertRejects(
        () =>
          verification.getVerifyKey(
            'logical.test',
            node.keyId,
            retiredAt + 1,
            'event',
          ),
        UpstreamError,
      );
      await assertRejects(
        () =>
          verification.getVerifyKey(
            'logical.test',
            node.keyId,
            retiredAt - 1,
            'request',
          ),
        UpstreamError,
      );
    } finally {
      await otherStore.close();
      await Deno.remove(otherDir, { recursive: true });
    }
    const journal = new Journal(await f.home.server(), LINK_CAPABILITIES);
    const forged = await journal.append('edge_a', {
      source: 'home',
      incarnation: f.bundle.id,
      stream: 'control',
      type: 'control',
      version: 1,
      operationId: 'forged',
      payload: {
        kind: 'key-roster',
        body: { server: 'logical.test', revision: 999, keys: [] },
        signature: 'x',
      },
    });
    await f.journal().receive('home', [forged]);
    await assertRejects(() => f.keys().apply(f.journal(), forged), LinkError);
    assertEquals(
      (await f.journal().heads('home', 'in', forged)).applied.sequence,
      forged.sequence - 1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('v28 upgrade preserves the received roster and rejects home-signed same-revision substitution', async () => {
  const f = await fixture();
  try {
    const first = await f.receive();
    await f.downgrade();
    await f.reopen();
    await f.keys().apply(f.journal(), first);
    const before = await f.keys().document();
    const prior = first.payload as {
      body: { server: string; revision: number; keys: unknown[] };
    };
    const body = {
      ...prior.body,
      keys: prior.body.keys.filter((key) =>
        (key as { keyId: string }).keyId === f.tenant.keyId
      ),
    };
    const forged = await new Journal(await f.home.server(), LINK_CAPABILITIES)
      .append('edge_a', {
        source: 'home',
        incarnation: f.bundle.id,
        stream: 'control',
        type: 'control',
        version: 1,
        operationId: 'changed-roster',
        payload: {
          kind: 'key-roster',
          body,
          signature: await f.tenant.signer().sign(canonicalJson(body)),
        },
      });
    await f.journal().receive('home', [forged]);
    await assertRejects(
      () => f.keys().apply(f.journal(), forged),
      LinkError,
      'changed control revision',
    );
    assertEquals(
      (await f.journal().heads('home', 'in', forged)).applied.sequence,
      1,
    );
    assertEquals(await f.keys().document(), before);
  } finally {
    await f.close();
  }
});
