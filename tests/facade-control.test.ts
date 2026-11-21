import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { closeApp, openApp } from '#engine/app.ts';
import { canonicalJson } from '#engine/canonical.ts';
import {
  exportKeyRoster,
  FacadeKeys,
  homeVerificationKeys,
  publishKeyDocument,
} from '#engine/facade/control.ts';
import { homeKeyDocument } from '#engine/federation/keydoc.ts';
import { startHomeLinks } from '#engine/facade/home.ts';
import { signWithSigner } from '#engine/federation/keys.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LINK_CAPABILITIES, LinkError } from '#engine/facade/protocol.ts';
import {
  changeSigningAuthority,
  VerificationUnavailable,
} from '#engine/facade/signing-authority.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';
import { openStore } from '#engine/store/index.ts';
import type { Database } from '#engine/store/db.ts';
import type { Signer } from '#engine/room/signer.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { startHttp } from './http-app.ts';
import { facadeTls } from './support/facade-tls.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';

async function fixture(seedServer = serverSchema) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-control-' });
  const open = (name: string, schema = serverSchema) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: schema, tenant: tenantSchema } });
  const home = await open('home', seedServer);
  let homeClosed = false;
  let edge = await open('edge', seedServer);
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
  const keys = (database = edgeServer, signer: Signer = node.signer()) =>
    new FacadeKeys(database, signer, node.publicKey, fp);
  const exportRoster = (now?: number) =>
    exportKeyRoster(
      home,
      tenant,
      'edge_a',
      bundle.id,
      (_id, doc) => keys().cosign(doc),
      now,
    );
  return {
    home,
    async openHomeApp() {
      await home.close();
      homeClosed = true;
      return await openApp({
        dir: dir + '/home',
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      });
    },
    tenant,
    node,
    hp,
    bundle,
    keys,
    server: () => edgeServer,
    journal,
    exportRoster,
    homeKeys: async () =>
      homeVerificationKeys(
        await home.server(),
        tenant.signer(),
        tenant.publicB64,
      ),
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
      return await exportKeyRoster(
        home,
        tenant,
        'edge_a',
        next.id,
        (_id, doc) => keys().cosign(doc),
      );
    },
    async downgrade() {
      await edgeServer.tx(async (conn) => {
        await conn.exec(
          'DROP TABLE facade_egress_routes; DROP TABLE facade_egress; DROP TABLE facade_ingress_collisions; DROP TABLE facade_ingress_children; DROP TABLE facade_ingress; DROP TABLE server_key_decisions; DROP TABLE federation_policy; DROP TABLE facade_scopes; DROP TABLE facade_exports; DROP TABLE facade_key_roster',
        );
        await conn.execute("UPDATE meta SET v='29' WHERE k='schema_version'");
      }, { mode: 'deferred' });
    },
    async receive(now?: number) {
      const record = await exportRoster(now);
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
      if (!homeClosed) await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('home link recovery publishes last-facade retirement before any public key request', async () => {
  const tls = await facadeTls();
  const f = await fixture();
  let app: Awaited<ReturnType<typeof openApp>> | undefined;
  let links: Awaited<ReturnType<typeof startHomeLinks>> | undefined;
  try {
    await f.receive();
    const retiredAt = Date.now();
    const revoked = await f.hp.revoke(f.bundle.id, retiredAt);
    setConfigForTests({
      server: { name: 'logical.test', role: 'home' },
      facade: {
        // The retired peer need not remain in the configured worker set.
        nodes: ['not_enrolled'],
        linkcert: tls.dir + '/home.crt',
        linkkey: tls.dir + '/home.key',
        linkcacerts: [tls.dir + '/ca.crt'],
      },
    });
    app = await f.openHomeApp();
    links = await startHomeLinks(app);
    // No key-document request or explicit control publisher repairs this cut.
    assertEquals(
      (await app.federationKeys.getVerifyKey(
        'logical.test',
        app.tenant.keyId,
        Date.now(),
        'event',
      )).algorithm.name,
      'Ed25519',
    );
    const [held] = await app.server.query(
      'SELECT revision,document_json FROM facade_key_roster WHERE singleton=1',
    );
    assertEquals(Number(held.revision), revoked.body.revision);
    const doc = JSON.parse(String(held.document_json));
    assertEquals(Object.keys(doc.verify_keys), [app.tenant.keyId]);
    assertEquals(doc.old_verify_keys[f.node.keyId], {
      key: f.node.publicKey,
      expired_ts: retiredAt,
    });
    assertEquals(
      await verifyJson(
        doc,
        'logical.test',
        app.tenant.keyId,
        await importPublicKeyFromRaw(matrixBase64(app.tenant.publicB64, 32)),
      ),
      true,
    );
  } finally {
    await links?.close();
    if (app) await closeApp();
    await f.close();
    await tls.close();
    setConfigForTests({});
  }
});

Deno.test('home-only App resolves its own key without logical-self acquisition', async () => {
  setConfigForTests({ server: { name: 'logical.test', role: 'home' } });
  const dir = await Deno.makeTempDir({ prefix: 'home-app-keys-' });
  try {
    const app = await openApp({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    });
    assertEquals(
      (await app.federationKeys.getVerifyKey(
        'logical.test',
        app.tenant.keyId,
        Date.now(),
        'event',
      )).algorithm.name,
      'Ed25519',
    );
    await assertRejects(
      () =>
        app.federationKeys.getVerifyKey(
          'logical.test',
          'ed25519:unknown',
          0,
          'event',
        ),
      UpstreamError,
      'local key unavailable',
    );
  } finally {
    await closeApp();
    await Deno.remove(dir, { recursive: true });
    setConfigForTests({});
  }
});

Deno.test('cold home App resolves its enrolled co-signed logical-server roster', async () => {
  setConfigForTests({ server: { name: 'logical.test', role: 'home' } });
  const f = await fixture();
  try {
    await f.receive();
    const app = await f.openHomeApp();
    for (const keyId of [f.tenant.keyId, f.node.keyId]) {
      assertEquals(
        (await app.federationKeys.getVerifyKey(
          'logical.test',
          keyId,
          Date.now(),
          'event',
        )).algorithm.name,
        'Ed25519',
      );
    }
    const [held] = await app.server.query(
      'SELECT document_json FROM facade_key_roster WHERE singleton=1',
    );
    const partial = JSON.parse(String(held.document_json));
    delete partial.signatures['logical.test'][f.node.keyId];
    for (const invalid of [null, '{', canonicalJson(partial)]) {
      await app.server.execute(
        'UPDATE facade_key_roster SET document_json=? WHERE singleton=1',
        [invalid],
      );
      for (const keyId of [f.tenant.keyId, f.node.keyId]) {
        await assertRejects<VerificationUnavailable | UpstreamError>(
          () =>
            app.federationKeys.getVerifyKey(
              'logical.test',
              keyId,
              0,
              'event',
            ),
          // PR #131: absent publication waits; malformed/forged authority refuses.
          invalid === null ? VerificationUnavailable : UpstreamError,
          invalid === null ? 'key document not ready' : 'local key unavailable',
        );
      }
    }
    await app.server.execute(
      'UPDATE facade_key_roster SET document_json=? WHERE singleton=1',
      [held.document_json],
    );
  } finally {
    await closeApp();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('co-signed publication includes every current key and is served unchanged offline', async () => {
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
    assertEquals(
      Object.keys(before.signatures['logical.test']).sort(),
      [f.tenant.keyId, f.node.keyId].sort(),
    );
    const publicKey = await importPublicKeyFromRaw(
      matrixBase64(f.node.publicKey, 32),
    );
    assert(await verifyJson(before, 'logical.test', f.node.keyId, publicKey));
    await f.reopen();
    assertEquals(await f.keys().apply(f.journal(), record), false);
    assertEquals(await f.keys().document(), before);
    const after = await f.keys().document(before.valid_until_ts - 1000);
    assertEquals(after, before);
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

Deno.test('both room replicas resolve only complete current local rosters and retain historical event validity', async () => {
  const f = await fixture();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    const complete = await f.keys().document();
    const floor = Date.now() - 10000;
    const expired = structuredClone(complete);
    expired.valid_until_ts = floor + 1000;
    expired.signatures = {};
    await signWithSigner(
      expired as unknown as Record<string, unknown>,
      f.tenant.signer(),
    );
    await signWithSigner(
      expired as unknown as Record<string, unknown>,
      f.node.signer(),
    );
    for (const db of [await f.home.server(), f.server()]) {
      const [saved] = await db.query(
        'SELECT revision,roster_json,document_json FROM facade_key_roster WHERE singleton=1',
      );
      try {
        for (
          const invalid of [
            'missing signature',
            'stale roster',
            'missing roster',
            'missing document',
            'corrupt document',
          ]
        ) {
          const partial = structuredClone(complete);
          delete partial.signatures['logical.test'][f.tenant.keyId];
          await db.execute(
            'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=? WHERE singleton=1',
            [
              invalid === 'stale roster' ? 0 : saved.revision,
              invalid === 'missing roster' ? null : saved.roster_json,
              invalid === 'missing document'
                ? null
                : invalid === 'corrupt document'
                ? '{'
                : invalid === 'missing signature'
                ? canonicalJson(partial)
                : saved.document_json,
            ],
          );
          const verifier = db === f.server()
            ? f.keys().verificationKeys()
            : await f.homeKeys();
          await assertRejects<VerificationUnavailable | UpstreamError>(
            () =>
              verifier.getVerifyKey(
                'logical.test',
                f.node.keyId,
                floor,
                'event',
              ),
            // PR #131 retains hard refusal for corrupt documents/signatures.
            ['stale roster', 'missing roster', 'missing document'].includes(
                invalid,
              )
              ? VerificationUnavailable
              : UpstreamError,
          );
        }
        await db.execute(
          'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=? WHERE singleton=1',
          [saved.revision, saved.roster_json, canonicalJson(expired)],
        );
        const verifier = db === f.server()
          ? f.keys().verificationKeys()
          : await f.homeKeys();
        assertEquals(
          (await verifier.getVerifyKey(
            'logical.test',
            f.node.keyId,
            floor,
            'event',
          ))
            .algorithm.name,
          'Ed25519',
        );
        await assertRejects(
          () =>
            verifier.getVerifyKey(
              'logical.test',
              f.node.keyId,
              Date.now(),
              'event',
            ),
          UpstreamError,
        );
        await assertRejects(
          () =>
            verifier.getVerifyKey(
              'logical.test',
              'ed25519:unknown',
              floor,
              'event',
            ),
          UpstreamError,
        );
      } finally {
        await db.execute(
          'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=? WHERE singleton=1',
          [saved.revision, saved.roster_json, saved.document_json],
        );
      }
    }
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('co-signed offline horizon expires without renewal and only home can refresh it', async () => {
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
    assertEquals(await f.keys().document(doc.valid_until_ts - 1), doc);
    await assertRejects(
      () => f.keys().document(doc.valid_until_ts),
      MatrixError,
      'expired',
    );
    await f.keys().contact(doc.valid_until_ts);
    await f.reopen();
    await assertRejects(
      () => f.keys().document(doc.valid_until_ts),
      MatrixError,
      'expired',
    );
    const refreshed = await f.receive(doc.valid_until_ts - 1000);
    await f.keys().apply(f.journal(), refreshed);
    assert(
      (await f.keys().document(doc.valid_until_ts)).valid_until_ts >
        doc.valid_until_ts,
    );
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('roster contacts serialize across owner instances and preserve the latest durable time', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = f.server();
  let active = 0;
  let peak = 0;
  let calls = 0;
  const database: Database = {
    ...server,
    async tx(fn, options) {
      active++;
      peak = Math.max(peak, active);
      try {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return await server.tx(fn, options);
      } finally {
        active--;
      }
    },
  };
  const latest = Date.now();
  const first = f.keys(database).contact(latest);
  try {
    await entered.promise;
    const second = f.keys(database).contact(latest - 1);
    release.resolve();
    await Promise.all([first, second]);
    assertEquals(
      peak,
      1,
      'one roster writer per canonical file, not per instance',
    );
    assertEquals(
      calls,
      2,
      'each authenticated contact commits its observation',
    );
    await f.reopen();
    assertEquals((await f.keys().status()).lastHome, latest);
  } finally {
    release.resolve();
    await first;
    await f.close();
  }
});

Deno.test('a failed roster contact releases its queued successor without hiding the failure', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = f.server();
  let calls = 0;
  const database: Database = {
    ...server,
    async tx(fn, options) {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
        throw new Error('injected contact commit failure');
      }
      return await server.tx(fn, options);
    },
  };
  const now = Date.now();
  const failure = assertRejects(
    () => f.keys(database).contact(now),
    Error,
    'injected contact commit failure',
  );
  try {
    await entered.promise;
    const successor = f.keys(database).contact(now + 1);
    release.resolve();
    await Promise.all([failure, successor]);
    await f.reopen();
    assertEquals((await f.keys().status()).lastHome, now + 1);
  } finally {
    release.resolve();
    await failure;
    await f.close();
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
      VerificationUnavailable,
      'key roster not ready',
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

Deno.test('verification distinguishes pending publications from invalid authority and preserves its fence across key loading', async (t) => {
  setConfigForTests({ facade: { maxofflinedays: 1 } });
  const f = await fixture();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    const server = f.server();
    const [original] = await server.query(
      'SELECT revision,roster_json,document_json FROM facade_key_roster WHERE singleton=1',
    );
    const lookup = (id = f.tenant.keyId, floor = 0) =>
      f.keys().verificationKeys().getVerifyKey(
        'logical.test',
        id,
        floor,
        'event',
      );
    const restore = () =>
      server.execute(
        'UPDATE facade_key_roster SET revision=?,roster_json=?,document_json=? WHERE singleton=1',
        [original.revision, original.roster_json, original.document_json],
      );
    for (
      const pending of ['missing roster', 'older roster', 'missing document']
    ) {
      await t.step(pending, async () => {
        await restore();
        if (pending === 'missing roster') {
          await server.execute(
            'UPDATE facade_key_roster SET roster_json=NULL WHERE singleton=1',
          );
        } else if (pending === 'older roster') {
          await server.execute(
            'UPDATE facade_key_roster SET revision=0 WHERE singleton=1',
          );
        } else {await server.execute(
            'UPDATE facade_key_roster SET document_json=NULL WHERE singleton=1',
          );}
        const error = await assertRejects(
          () => lookup(),
          VerificationUnavailable,
          'not ready',
        );
        assertEquals(error.code, 'LINK_UNAVAILABLE');
        await restore();
        assertEquals((await lookup()).algorithm.name, 'Ed25519');
      });
    }
    for (
      const corrupt of [
        'document bytes',
        'document signature',
        'document identity',
        'unknown key',
        'validity floor',
      ]
    ) {
      await t.step(corrupt, async () => {
        await restore();
        if (corrupt.startsWith('document')) {
          const document = JSON.parse(String(original.document_json));
          if (corrupt === 'document signature') {
            document.signatures['logical.test'][f.tenant.keyId] = 'A'.repeat(
              86,
            );
          }
          if (corrupt === 'document identity') {
            document.server_name = 'wrong.test';
          }
          await server.execute(
            'UPDATE facade_key_roster SET document_json=? WHERE singleton=1',
            [corrupt === 'document bytes' ? '{}' : JSON.stringify(document)],
          );
        }
        await assertRejects(
          () =>
            lookup(
              corrupt === 'unknown key' ? 'ed25519:unknown' : f.tenant.keyId,
              corrupt === 'validity floor' ? Number.MAX_SAFE_INTEGER : 0,
            ),
          UpstreamError,
          'local key unavailable',
        );
      });
    }
    await restore();
    await t.step('authority changes during the asynchronous read', async () => {
      let changed = false;
      const database: Database = {
        ...server,
        async query(sql, values) {
          const rows = await server.query(sql, values);
          if (!changed && sql.includes('FROM facade_key_roster')) {
            changed = true;
            await changeSigningAuthority(server, () => Promise.resolve());
          }
          return rows;
        },
      };
      const error = await assertRejects(
        () =>
          f.keys(database).verificationKeys().getVerifyKey(
            'logical.test',
            f.tenant.keyId,
            0,
            'event',
          ),
        VerificationUnavailable,
        'authority changed',
      );
      assertEquals(error.code, 'LINK_UNAVAILABLE');
      assertEquals((await lookup()).algorithm.name, 'Ed25519');
    });
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('pending verification authority is retryable at the real public HTTP boundary', async () => {
  const f = await fixture();
  const http = await startHttp();
  try {
    const owner = f.keys();
    http.app.federationKeys.getVerifyKey =
      owner.verificationKeys().getVerifyKey;
    const uri = '/_matrix/federation/v1/query/nope';
    const origin = f.tenant.serverName;
    const destination = http.app.tenant.serverName;
    const signature = await f.tenant.signer().sign(
      canonicalJson({ method: 'GET', uri, origin, destination }),
    );
    const request = () =>
      new Request('http://x' + uri, {
        headers: {
          authorization:
            `X-Matrix origin="${origin}",destination="${destination}",key="${f.tenant.keyId}",sig="${signature}"`,
        },
      });
    const waiting = await http.matrix(request());
    assertEquals(waiting.status, 503);
    assertEquals((await waiting.json()).errcode, 'M_UNAVAILABLE');
    const record = await f.receive();
    await owner.apply(f.journal(), record);
    const ready = await http.matrix(request());
    assertEquals(ready.status, 404);
    assertEquals((await ready.json()).errcode, 'M_UNRECOGNIZED');
  } finally {
    await http.close();
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
    const doc = await f.keys().document();
    const clock = Date.now;
    try {
      Date.now = () => doc.valid_until_ts;
      await assertRejects(
        () => f.keys().requestSigner().sign('not signed'),
        MatrixError,
        'expired',
      );
    } finally {
      Date.now = clock;
    }
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('prepared facade signer uses no database inside a room transaction and expires before signing', async () => {
  setConfigForTests({ facade: { maxofflinedays: 1 } });
  const f = await fixture();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    let forbidden = false;
    const server = f.server();
    const database: Database = {
      ...server,
      tx(fn, options) {
        if (forbidden) throw new Error('nested server database access');
        return server.tx(fn, options);
      },
      query(sql, values) {
        if (forbidden) throw new Error('nested server database access');
        return server.query(sql, values);
      },
    };
    let signatures = 0;
    const raw = f.node.signer();
    const keys = f.keys(database, {
      ...raw,
      sign(bytes) {
        signatures++;
        return raw.sign(bytes);
      },
    });
    const permit = await keys.prepareSigner();
    const doc = await keys.document();
    forbidden = true;
    assertEquals(await permit.sign('room bytes'), await raw.sign('room bytes'));
    const clock = Date.now;
    try {
      Date.now = () => doc.valid_until_ts;
      await assertRejects(() => permit.sign('expired'), MatrixError, 'expired');
    } finally {
      Date.now = clock;
    }
    assertEquals(signatures, 1);
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('prepared facade signing is fenced across owners and during asynchronous signatures', async () => {
  setConfigForTests({ federation: { keyvalidityhours: 1 } });
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    const prior = await f.keys().prepareSigner();
    const raw = f.node.signer();
    const delayed = await f.keys(f.server(), {
      ...raw,
      async sign(bytes) {
        entered.resolve();
        await release.promise;
        return raw.sign(bytes);
      },
    }).prepareSigner();
    const pending = assertRejects(
      () => delayed.sign('racing room bytes'),
      MatrixError,
      'changed',
    );
    await entered.promise;
    const next = await f.reenroll();
    release.resolve();
    await pending;
    await assertRejects(() => prior.sign('stale'), MatrixError, 'changed');
    await f.journal().receive('home', [next]);
    await f.keys().apply(f.journal(), next);
    const fresh = await f.keys().prepareSigner();
    assertEquals(await fresh.sign('fresh'), await raw.sign('fresh'));
  } finally {
    release.resolve();
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('key-document replacement fences permits before its transaction completes', async () => {
  setConfigForTests({
    federation: { keyvalidityhours: 1 },
    facade: { maxofflinedays: 1 },
  });
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let applying: Promise<boolean> | undefined;
  try {
    const first = await f.receive();
    await f.keys().apply(f.journal(), first);
    const prior = await f.keys().prepareSigner();
    const replacement = await f.exportRoster(Date.now() + 3600000);
    assert(replacement.sequence > first.sequence);
    await f.journal().receive('home', [replacement]);
    const server = f.server();
    let calls = 0;
    const database: Database = {
      ...server,
      async tx(fn, options) {
        if (++calls === 2) {
          entered.resolve();
          await release.promise;
        }
        return server.tx(fn, options);
      },
    };
    applying = f.keys().apply(
      new Journal(database, LINK_CAPABILITIES),
      replacement,
    );
    await entered.promise;
    await assertRejects(
      () => prior.sign('pending document'),
      MatrixError,
      'changed',
    );
    await assertRejects(() => f.keys().prepareSigner(), MatrixError, 'changed');
    release.resolve();
    await applying;
    await assertRejects(
      () => prior.sign('old document'),
      MatrixError,
      'changed',
    );
    const fresh = await f.keys().prepareSigner();
    assertEquals(
      await fresh.sign('fresh'),
      await f.node.signer().sign('fresh'),
    );
  } finally {
    release.resolve();
    await applying;
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
      for (
        const verification of [f.keys().verificationKeys(), await f.homeKeys()]
      ) {
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
      }
      const verification = f.keys().verificationKeys();
      await f.server().execute(
        'UPDATE facade_key_roster SET document_json=NULL WHERE singleton=1',
      );
      try {
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
        await assertRejects(
          () =>
            verification.getVerifyKey(
              'logical.test',
              node.keyId,
              retiredAt,
              'event',
            ),
          VerificationUnavailable,
          'not ready',
        );
      } finally {
        await f.server().execute(
          'UPDATE facade_key_roster SET document_json=? WHERE singleton=1',
          [canonicalJson(doc)],
        );
      }
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
  const f = await fixture(historicalServerSchema(35));
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

Deno.test('co-signed publication never exposes a failed or invalid signature collection', async () => {
  const f = await fixture();
  try {
    const db = await f.home.server();
    const read = () =>
      homeKeyDocument(db, f.tenant.signer(), f.tenant.publicB64);
    const publish = (
      collect: (
        _id: string,
        doc: import('#engine/federation/keys.ts').KeyDoc,
      ) => Promise<string>,
      now?: number,
    ) =>
      publishKeyDocument(
        db,
        f.tenant.signer(),
        f.tenant.publicB64,
        collect,
        now,
      );
    await assertRejects(
      () => publish(() => Promise.reject(new Error('link disconnected'))),
      Error,
      'disconnected',
    );
    await assertRejects(read, MatrixError, 'not ready');
    await assertRejects(
      () => publish(() => Promise.resolve('invalid')),
      LinkError,
      'signature',
    );
    await assertRejects(read, MatrixError, 'not ready');
    const first = await f.receive();
    await f.keys().apply(f.journal(), first);
    const before = await read();
    setConfigForTests({ facade: { maxofflinedays: 1 } });
    await assertRejects(
      () => publish(() => Promise.reject(new Error('refresh disconnected'))),
      Error,
      'disconnected',
    );
    assertEquals(await read(), before);
    assertEquals(await f.keys().document(), before);
    const next = await f.receive();
    assert(next.operationId !== first.operationId);
    await f.keys().apply(f.journal(), next);
    const refreshed = await read();
    assert(refreshed.valid_until_ts < before.valid_until_ts);
    assertEquals(await f.keys().document(), refreshed);
    assertEquals(
      Object.keys(refreshed.signatures['logical.test']).sort(),
      Object.keys(refreshed.verify_keys).sort(),
    );
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('legacy facade-only cached documents confer no authority and a complete same-roster publication repairs them', async () => {
  const f = await fixture();
  try {
    const record = await f.receive();
    await f.keys().apply(f.journal(), record);
    const complete = await f.keys().document();
    const partial = structuredClone(complete);
    delete partial.signatures['logical.test'][f.tenant.keyId];
    await f.server().tx(async (conn) => {
      await conn.execute(
        'UPDATE facade_key_roster SET document_json=? WHERE singleton=1',
        [canonicalJson(partial)],
      );
    });
    await f.reopen();
    await assertRejects(() => f.keys().document(), MatrixError, 'not ready');
    assertEquals((await f.keys().status()).ready, false);
    await assertRejects(
      () => f.keys().requestSigner().sign('not authorized'),
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
    // Re-apply a new complete publication at the same roster revision.
    setConfigForTests({ facade: { maxofflinedays: 2 } });
    const next = await f.receive();
    await f.keys().apply(f.journal(), next);
    assertEquals((await f.keys().status()).ready, true);
    assertEquals((await f.keys().document()).verify_keys, complete.verify_keys);
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('a failed connected refresh preserves valid publication and export progress while reporting its failure', async () => {
  setConfigForTests({
    federation: { keyvalidityhours: 1 },
    facade: { maxofflinedays: 1 },
  });
  const f = await fixture();
  try {
    const first = await f.receive();
    await f.keys().apply(f.journal(), first);
    const before = await f.keys().document();
    const errors: unknown[] = [];
    const failed = new Error('refresh signing link disconnected');
    const now = Date.now() + 3600000;
    const exported = await exportKeyRoster(
      f.home,
      f.tenant,
      'edge_a',
      f.bundle.id,
      () => Promise.reject(failed),
      now,
      (error) => errors.push(error),
    );
    assertEquals(exported, first);
    assertEquals(errors, [failed]);
    assertEquals(await f.keys().document(now), before);
    await assertRejects(
      () =>
        exportKeyRoster(
          f.home,
          f.tenant,
          'edge_a',
          f.bundle.id,
          () => Promise.reject(failed),
          before.valid_until_ts,
          (error) => errors.push(error),
        ),
      MatrixError,
      'expired',
    );
    assertEquals(
      errors,
      [failed],
      'expired authority cannot be disguised as a recoverable refresh',
    );
  } finally {
    await f.close();
    setConfigForTests({});
  }
});

Deno.test('a slow failed refresh cannot retain a publication that expired during collection', async () => {
  setConfigForTests({ facade: { maxofflinedays: 1 } });
  const f = await fixture();
  const clock = Date.now;
  try {
    const first = await f.receive();
    await f.keys().apply(f.journal(), first);
    const before = await f.keys().document();
    const started = before.valid_until_ts - 1;
    const db = await f.home.server();
    const errors: unknown[] = [];
    Date.now = () => started;
    await assertRejects(
      () =>
        publishKeyDocument(
          db,
          f.tenant.signer(),
          f.tenant.publicB64,
          () => {
            Date.now = () => before.valid_until_ts;
            return Promise.reject(new Error('slow collection failed'));
          },
          started,
          (error) => errors.push(error),
        ),
      MatrixError,
      'expired',
    );
    assertEquals(
      errors,
      [],
      'expired authority cannot report retained success',
    );
  } finally {
    Date.now = clock;
    await f.close();
    setConfigForTests({});
  }
});
