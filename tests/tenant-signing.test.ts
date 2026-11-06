// A counterpart retains (server, key id) until expiry. A fresh install must
// name its new key differently; published docs, requests and PDUs agree on it.
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { redact } from '#engine/eventid.ts';
import {
  federationRequest,
  resetCaCertsForTests,
} from '#engine/federation/client.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';
import { parseXMatrixHeaders } from '#engine/federation/xmatrix.ts';
import { buildCreate } from '#engine/room/build.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import {
  nativeNameFor,
  openTenant,
  tenantSchema,
} from '#engine/tenant/index.ts';
import {
  b64decode,
  b64encodeStd,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';

Deno.test('tenant: cached counterpart verifies replacement and legacy ids in key docs, X-Matrix and PDUs', async () => {
  const dir = await Deno.makeTempDir();
  const cached = new Map<string, CryptoKey>();
  let currentDoc: Awaited<ReturnType<typeof ourKeyDocument>>;
  const received: { key: string; request: boolean; pdu: boolean }[] = [];
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const remote = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  }, async (request) => {
    const [auth] = parseXMatrixHeaders([request.headers.get('authorization')!]);
    const cacheKey = auth.origin + '/' + auth.key;
    if (!cached.has(cacheKey)) {
      cached.set(
        cacheKey,
        await importPublicKeyFromRaw(
          b64decode(currentDoc.verify_keys[auth.key].key),
        ),
      );
    }
    const publicKey = cached.get(cacheKey)!;
    const url = new URL(request.url);
    const content = await request.json();
    const validRequest = await verifyJson(
      {
        method: request.method,
        uri: url.pathname + url.search,
        origin: auth.origin,
        destination: auth.destination,
        content,
        signatures: { [auth.origin]: { [auth.key]: auth.signature } },
      },
      auth.origin,
      auth.key,
      publicKey,
    );
    const pdu = redact(content.pdus[0], '11');
    delete pdu.event_id;
    const validPdu = await verifyJson(pdu, auth.origin, auth.key, publicKey);
    const observed = { key: auth.key, request: validRequest, pdu: validPdu };
    received.push(observed);
    return Response.json(observed);
  });
  try {
    const ids: string[] = [];
    // The first two are independent fresh installs with the same DNS name.
    // The third is an existing row in the original key_id '1' format.
    for (const install of ['first', 'replacement', 'legacy']) {
      const serverName = install === 'legacy' ? 'legacy.test' : 'same.test';
      const store = await openStore({
        dir: dir + '/' + install,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { server: serverSchema, tenant: tenantSchema } });
      try {
        if (install === 'legacy') {
          const pair = await generateSigningKeypair() as CryptoKeyPair;
          const raw = await exportPublicKeyRaw(pair.publicKey);
          const db = await store.tenant(serverName, { create: true });
          await db.tx(async (conn) =>
            conn.execute(
              'INSERT INTO tenant (server_name, native_name, pubkey_b64, privkey_enc, key_id, created_ms) VALUES (?, ?, ?, ?, ?, ?)',
              [
                serverName,
                nativeNameFor(raw),
                b64encodeStd(raw),
                b64encodeStd(await exportPrivateKeyPkcs8(pair.privateKey)),
                '1',
                Date.now(),
              ],
            )
          );
        }
        const tenant = await openTenant(store, serverName, { create: true });
        if (install === 'legacy') assertEquals(tenant.keyId, 'ed25519:1');
        ids.push(tenant.keyId);
        currentDoc = await ourKeyDocument(tenant.signer(), tenant.publicB64);
        assertEquals(Object.keys(currentDoc.verify_keys), [tenant.keyId]);
        assertEquals(Object.keys(currentDoc.signatures[serverName]), [
          tenant.keyId,
        ]);
        assertEquals(currentDoc.old_verify_keys, {});
        assert(
          await verifyJson(
            currentDoc,
            serverName,
            tenant.keyId,
            await importPublicKeyFromRaw(b64decode(tenant.publicB64)),
          ),
        );
        const pdu = await buildCreate(
          {
            sender: '@alice:' + serverName,
            roomId: '!room:' + serverName,
            content: { room_version: '11', creator: '@alice:' + serverName },
          },
          tenant.signer(),
          '11',
        );
        assertEquals(Object.keys(pdu.signatures![serverName]), [tenant.keyId]);
        const response = await federationRequest(
          await store.server(),
          tenant.signer(),
          {
            destination: 'localhost:' + (remote.addr as Deno.NetAddr).port,
            method: 'PUT',
            path: '/_matrix/federation/v1/send/f12',
            body: new TextEncoder().encode(
              JSON.stringify({ pdus: [pdu], edus: [] }),
            ),
          },
        );
        assertEquals(response.status, 200);
        assertEquals(response.json, {
          key: tenant.keyId,
          request: true,
          pdu: true,
        });
        const reopened = await openTenant(store, serverName);
        assertEquals(reopened.keyId, tenant.keyId);
        assertEquals(reopened.publicB64, tenant.publicB64);
        if (install === 'legacy') {
          const db = await store.tenant(serverName);
          assertEquals(
            await db.tx((conn) => conn.query('SELECT key_id FROM tenant')),
            [{ key_id: '1' }],
          );
        }
      } finally {
        await store.close();
      }
    }
    assertEquals(received.map((r) => r.key), ids);
    assertEquals(
      cached.size,
      3,
      'the old key remains cached beside the replacement',
    );
  } finally {
    await remote.shutdown();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
    await Deno.remove(dir, { recursive: true });
  }
});
