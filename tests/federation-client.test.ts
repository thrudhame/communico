// tests/federation-client.test.ts — the signed outbound client against
// the fake remote server (real TLS, fixture CA): header grammar,
// destination sent, Content-Type on bodies, Matrix error passthrough,
// connect timeout → 502, the resolver's explicit-port and roster
// round trips (doltgres tests/federation-client.test.ts, restored) —
// and the node:tls dialer: pinned peers match the roster SPKI hash,
// key-is-name peers the raw 32-byte key equality, mismatches a 502
// before any request bytes are written (doltgres
// tests/federation-dial.test.ts, restored).
import { assert, assertEquals } from '@std/assert';
import { createHash, X509Certificate } from 'node:crypto';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { addPeer, removePeer } from '#engine/federation/peers.ts';
import { resolve } from '#engine/federation/resolve.ts';
import {
  federationRequest,
  resetCaCertsForTests,
} from '#engine/federation/client.ts';
import {
  b32encode,
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
} from '#engine/signing-primitives.js';
import type { Signer } from '#engine/room/signer.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { randomSigner } from './fixtures/signer.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Identity = { signer: Signer; doc: Record<string, unknown> };

async function makeIdentity(name: string): Promise<Identity> {
  const { signer, publicKey } = await randomSigner(name);
  return {
    signer,
    doc: {
      server_name: name,
      verify_keys: {
        [signer.keyId]: {
          key: b64encodeStd(await exportPublicKeyRaw(publicKey)),
        },
      },
      old_verify_keys: {},
      valid_until_ts: Date.now() + 86400_000,
      signatures: {},
    },
  };
}

async function withFake<T>(
  identity: Identity,
  fn: (fake: FakeServer) => Promise<T>,
): Promise<T> {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  const fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(identity.doc),
  });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

Deno.test('client: GET to the fake verifies — header grammar, destination, no body type', async () => {
  const identity = await makeIdentity('client1.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const res = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/_matrix/key/v2/server',
          body: null,
        },
      );
      assertEquals(res.status, 200);
      const last = fake.requests[fake.requests.length - 1];
      assertEquals(last.method, 'GET');
      assertEquals(last.verified, true);
      const doc = res.json as Record<string, unknown>;
      assertEquals(doc.server_name, `localhost:${fake.port}`);
    });
  });
});

Deno.test('client: POST carries Content-Type and signs the content', async () => {
  const identity = await makeIdentity('client2.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const body = new TextEncoder().encode('{"x":1}');
      const err = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'POST',
          path: '/whatever',
          body,
        },
      ).then(() => 'ok', (e: unknown) => e);
      assert((err as MatrixError) instanceof MatrixError);
      assertEquals((err as MatrixError).status, 404);
      const last = fake.requests[fake.requests.length - 1];
      assertEquals(last.method, 'POST');
      const gotBody = last.body;
      assert(gotBody !== null);
      assertEquals(new TextDecoder().decode(gotBody), '{"x":1}');
      assertEquals(last.verified, true);
    });
  });
});

Deno.test('client: a Matrix error body passes through with its own status and errcode', async () => {
  const identity = await makeIdentity('client3.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const err = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/nothing-real',
          body: null,
        },
      ).then(
        () => 'resolved',
        (e) => e as MatrixError,
      );
      assert(err instanceof MatrixError);
      assertEquals(err.status, 404);
      assertEquals(err.errcode, 'M_UNRECOGNIZED');
    });
  });
});

Deno.test('client: connect timeout → 502 within connectms + margin', async () => {
  const identity = await makeIdentity('client4.test');
  setConfigForTests({ federation: { connectms: 300 } });
  await withStore(async (store) => {
    const t0 = Date.now();
    const err = await federationRequest(await store.server(), identity.signer, {
      destination: '10.255.255.1:8448',
      method: 'GET',
      path: '/x',
      body: null,
    }).then(() => 'ok', (e) => e as MatrixError);
    const ms = Date.now() - t0;
    assert(err instanceof MatrixError);
    assertEquals(err.status, 502);
    assert(ms < 3000, `took ${ms}ms`);
  });
  setConfigForTests({ federation: { connectms: 5000 } });
});

Deno.test('resolver round trip: explicit port against the fake', async () => {
  const identity = await makeIdentity('client5.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const ep = await resolve(await store.server(), `localhost:${fake.port}`);
      assertEquals(ep.port, fake.port);
      const res = await federationRequest(
        await store.server(),
        identity.signer,
        {
          destination: `localhost:${fake.port}`,
          method: 'GET',
          path: '/_matrix/key/v2/server',
          body: null,
        },
      );
      assertEquals(res.status, 200);
    });
  });
});

Deno.test('resolver round trip: roster override connects; identity stays the server name', async () => {
  const identity = await makeIdentity('client6.test');
  await withStore(async (store) => {
    await withFake(identity, async (fake) => {
      const server = await store.server();
      await addPeer(server, {
        name: 'localhost',
        host: '127.0.0.1',
        port: fake.port,
        trust: 'ca',
        addedBy: 'operator',
      });
      const ro = await server.query(
        'SELECT name FROM federation_peers WHERE name = ?',
        ['localhost'],
      );
      assertEquals(ro.length, 1);
      const ep = await resolve(server, 'localhost');
      assertEquals(ep.port, fake.port);
      assertEquals(ep.connectIp, '127.0.0.1');
      const res = await federationRequest(server, identity.signer, {
        destination: 'localhost',
        method: 'GET',
        path: '/_matrix/key/v2/server',
        body: null,
      });
      assertEquals(res.status, 200);
      await removePeer(server, 'localhost');
    });
  });
});

// --- the node:tls dialer -------------------------------------------------

function pinOf(pem: string): string {
  const x = new X509Certificate(pem);
  const spki = x.publicKey.export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(spki).digest('hex');
}

async function withTlsFake<T>(
  certPem: string,
  keyPem: string,
  fn: (port: number) => Promise<T>,
): Promise<T> {
  const server = Deno.serve(
    { port: 0, cert: certPem, key: keyPem },
    () => new Response('dial test'),
  );
  const port = (server.addr as Deno.NetAddr).port;
  try {
    return await fn(port);
  } finally {
    await server.shutdown();
  }
}

Deno.test('dial: pinned peer → SPKI match round trips; wrong pin → 502', async () => {
  const identity = await makeIdentity('dial1.test');
  await withStore(async (store) => {
    const server = await store.server();
    const pem = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
    const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
    const pin = pinOf(pem);
    await withTlsFake(pem, key, async (port) => {
      await addPeer(server, {
        name: 'localhost',
        host: '127.0.0.1',
        port,
        trust: 'pinned',
        pin,
        addedBy: 'operator',
      });
      const ok = await federationRequest(server, identity.signer, {
        destination: 'localhost',
        method: 'GET',
        path: '/x',
        body: null,
      });
      assertEquals(ok.status, 200);
      // wrong pin → 502 with the pin message
      await addPeer(server, {
        name: 'localhost',
        host: '127.0.0.1',
        port,
        trust: 'pinned',
        pin: 'f'.repeat(64),
        addedBy: 'operator',
      });
      const err = await federationRequest(server, identity.signer, {
        destination: 'localhost',
        method: 'GET',
        path: '/x',
        body: null,
      }).then(() => 'ok', (e: unknown) => e as MatrixError);
      assert((err as MatrixError) instanceof MatrixError);
      assertEquals((err as MatrixError).status, 502);
      assert((err as MatrixError).message.includes('pin'));
      await removePeer(server, 'localhost');
    });
  });
});

Deno.test('dial: key-is-name peer → raw key equality round trips', async () => {
  const identity = await makeIdentity('dial2.test');
  await withStore(async (store) => {
    const server = await store.server();
    const kp = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
    const rawPub = await exportPublicKeyRaw(kp.publicKey);
    const name = b32encode(rawPub).toLowerCase().replace(/=+$/, '');
    // mint a self-signed Ed25519 cert from that key (openssl CLI)
    const pkcs8 = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
    const der = new Uint8Array(pkcs8);
    const b64 = btoa(String.fromCharCode(...der));
    const lines = (b64.match(/.{1,64}/g) ?? []).join(String.fromCharCode(10));
    const pem = '-----BEGIN PRIVATE KEY-----\n' + lines +
      '\n-----END PRIVATE KEY-----\n';
    const tmp = await Deno.makeTempFile();
    await Deno.writeTextFile(tmp, pem);
    const certPath = await Deno.makeTempFile();
    const out = await new Deno.Command('openssl', {
      args: [
        'req',
        '-x509',
        '-key',
        tmp,
        '-subj',
        `/CN=${name}`,
        '-days',
        '3650',
        '-out',
        certPath,
      ],
      stderr: 'null',
    }).output();
    assert(out.success);
    const certPem = await Deno.readTextFile(certPath);
    await withTlsFake(certPem, pem, async (port) => {
      await addPeer(server, {
        name,
        host: '127.0.0.1',
        port,
        trust: 'keyname',
        addedBy: 'operator',
      });
      const ok = await federationRequest(server, identity.signer, {
        destination: name,
        method: 'GET',
        path: '/x',
        body: null,
      });
      assertEquals(ok.status, 200);
      // a wrong raw key → 502 with the key message
      const other =
        (await generateSigningKeypair()) as unknown as CryptoKeyPair;
      const otherRaw = await exportPublicKeyRaw(other.publicKey);
      const otherName = b32encode(otherRaw).toLowerCase().replace(/=+$/, '');
      await addPeer(server, {
        name: otherName,
        host: '127.0.0.1',
        port,
        trust: 'keyname',
        addedBy: 'operator',
      });
      const err = await federationRequest(server, identity.signer, {
        destination: otherName,
        method: 'GET',
        path: '/x',
        body: null,
      }).then(() => 'ok', (e: unknown) => e as MatrixError);
      assert((err as MatrixError) instanceof MatrixError);
      assertEquals((err as MatrixError).status, 502);
      assert((err as MatrixError).message.includes('key'));
      await removePeer(server, name);
      await removePeer(server, otherName);
    });
  });
});
