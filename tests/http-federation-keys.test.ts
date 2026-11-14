// doltgres http-contract + federation-disabled: real HTTP key/version doors.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { config, serverName, setConfigForTests } from '#engine/config.ts';
import { federationRequest } from '#engine/federation/client.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { httpSuite } from './http-app.ts';
import { directOnly, makeDoc, makeServer } from './federation/doc-helper.ts';
import {
  b64decode,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';

const { matrix, test } = httpSuite(
  'HTTP federation keys, version and delegation',
);
const get = (path: string) => matrix(new Request('http://x' + path));

test('our key document and deprecated key-id path are signed and public', async () => {
  for (
    const path of [
      '/_matrix/key/v2/server',
      '/_matrix/key/v2/server/' + theApp().tenant.keyId,
    ]
  ) {
    const res = await get(path);
    assertEquals(res.status, 200);
    const doc = await res.json();
    assertEquals(doc.server_name, serverName());
    const ids = Object.keys(doc.verify_keys);
    assertEquals(ids.length, 1);
    assertEquals(ids, [theApp().tenant.keyId]);
    assertEquals(Object.keys(doc.signatures), [serverName()]);
    assert(
      await verifyJson(
        doc,
        serverName(),
        ids[0],
        await importPublicKeyFromRaw(b64decode(doc.verify_keys[ids[0]].key)),
      ),
    );
  }
});

test('both public key-document paths publish the approved roster and exact retirement cut', async () => {
  const app = theApp();
  const dir = await Deno.makeTempDir({ prefix: 'http-key-roster-' });
  const facade = await openStore({
    ...config().store,
    dir,
  }, { schemas: { server: serverSchema } });
  try {
    const node = await initializeNode(
      await facade.server(),
      serverName(),
      'key_edge',
    );
    const homePin = 'a'.repeat(64);
    const facadePin = 'b'.repeat(64);
    const home = new Pairings(
      app.server,
      app.tenant.signer(),
      app.tenant.publicB64,
      homePin,
    );
    const edge = new Pairings(
      await facade.server(),
      node.signer(),
      node.publicKey,
      facadePin,
      node,
    );
    const bundle = await home.create({
      node: node.node,
      url: 'https://edge.test',
      facadePin,
      expires: Date.now() + 60000,
      required: [{ type: 'control', version: 1 }],
    });
    await edge.accept(bundle);
    await home.grant(
      bundle.id,
      await edge.challenge(bundle.id, bundle.secret, homePin),
    );
    const cut = Date.now();
    for (const retired of [false, true]) {
      if (retired) await home.revoke(bundle.id, cut);
      for (const suffix of ['', '/' + node.keyId]) {
        const res = await get('/_matrix/key/v2/server' + suffix);
        assertEquals(res.status, 200);
        const doc = await res.json();
        if (retired) {
          assertEquals(doc.verify_keys[node.keyId], undefined);
          assertEquals(doc.old_verify_keys[node.keyId], {
            key: node.publicKey,
            expired_ts: cut,
          });
        } else {
          assertEquals(doc.verify_keys[node.keyId], { key: node.publicKey });
        }
        assert(
          await verifyJson(
            doc,
            serverName(),
            app.tenant.keyId,
            await importPublicKeyFromRaw(b64decode(app.tenant.publicB64)),
          ),
        );
      }
    }
  } finally {
    await facade.close();
    await Deno.remove(dir, { recursive: true });
  }
});

test('notary misses do not fetch; cached GET/POST preserve origin signature and validity', async () => {
  const missing = await get('/_matrix/key/v2/query/no-such-server.test');
  assertEquals(missing.status, 200);
  assertEquals(await missing.json(), { server_keys: [] });
  const origin = await makeServer('held.test');
  const doc = await makeDoc(origin);
  await keyStore(theApp().server, { deps: directOnly(doc) }).acquireKeyDoc(
    origin.name,
    0,
  );
  for (
    const request of [
      new Request('http://x/_matrix/key/v2/query/held.test'),
      new Request('http://x/_matrix/key/v2/query', {
        method: 'POST',
        body: JSON.stringify({ server_keys: { 'held.test': {} } }),
      }),
    ]
  ) {
    const res = await matrix(request);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.server_keys.length, 1);
    const answer = body.server_keys[0];
    assertEquals(answer.server_name, origin.name);
    assertEquals(answer.valid_until_ts, doc.valid_until_ts);
    assert(answer.signatures[serverName()] !== undefined);
    assert(
      await verifyJson(answer, origin.name, origin.keyId, origin.kp.publicKey),
    );
    assert(
      await verifyJson(
        answer,
        serverName(),
        theApp().tenant.keyId,
        await importPublicKeyFromRaw(b64decode(theApp().tenant.publicB64)),
      ),
    );
  }
});

test('version, misses, wrong methods and well-known match the old contracts', async () => {
  const res = await get('/_matrix/federation/v1/version');
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.server.name, 'communico');
  assert(typeof body.server.version === 'string');
  for (
    const path of ['/_matrix/key/v2/unknown', '/_matrix/federation/unknown']
  ) {
    const miss = await get(path);
    assertEquals(miss.status, 404);
    assertEquals((await miss.json()).errcode, 'M_UNRECOGNIZED');
  }
  for (
    const path of ['/_matrix/key/v2/query', '/_matrix/federation/v1/version']
  ) {
    const put = await matrix(new Request('http://x' + path, { method: 'PUT' }));
    assertEquals(put.status, 405);
    assertEquals((await put.json()).errcode, 'M_UNRECOGNIZED');
  }
  const absent = await get('/.well-known/matrix/server');
  assertEquals(absent.status, 404);
  await absent.text();
  setConfigForTests({
    federation: { wellknown: 'delegate.test:8448', wellknownmaxage: 123 },
  });
  try {
    const delegated = await get('/.well-known/matrix/server');
    assertEquals(delegated.status, 200);
    assertEquals(delegated.headers.get('cache-control'), 'max-age=123');
    assertEquals(await delegated.json(), { 'm.server': 'delegate.test:8448' });
  } finally {
    setConfigForTests({});
  }
});

test('disabled: federation, keys and well-known 404, outbound refused', async () => {
  setConfigForTests({ federation: { enabled: false } });
  try {
    for (
      const path of [
        '/_matrix/federation/v1/version',
        '/_matrix/key/v2/server',
        '/.well-known/matrix/server',
      ]
    ) {
      const res = await get(path);
      assertEquals(res.status, 404);
      await res.text();
    }
    const err = await federationRequest(
      theApp().server,
      theApp().tenant.signer(),
      {
        destination: 'else.test',
        method: 'GET',
        path: '/x',
        body: null,
      },
    ).then(() => null, (e: unknown) => e);
    assert(err instanceof MatrixError);
    assertEquals(err.status, 502);
    assert(err.message.includes('disabled'));
  } finally {
    setConfigForTests({});
  }
});
