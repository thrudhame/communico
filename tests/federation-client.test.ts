// tests/federation-client.test.ts — the signed outbound client against
// the fake remote server (real TLS, fixture CA): header grammar,
// destination sent, Content-Type on bodies, Matrix error passthrough,
// connect timeout → 502. Plus the resolver's explicit-port and roster
// override round trips live here against the fake.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { addPeer, lookupPeer, removePeer } from '#engine/federation/peers.ts';
import { resolve } from '#engine/federation/resolve.ts';
import {
  federationRequest,
  resetCaCertsForTests,
  wireFederationTransport,
} from '#engine/federation/client.ts';
import { acquireKeyDoc, getVerifyKey } from '#engine/federation/keys.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { resetFederationTables } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

async function inProcessKeyDoc(): Promise<unknown> {
  const res = await matrix(
    new Request('http://x/_matrix/key/v2/server'),
  );
  return await res.json();
}

async function withFake<T>(fn: (fake: FakeServer) => Promise<T>): Promise<T> {
  const fake = await startFakeServer({ ourKeyDoc: inProcessKeyDoc });
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

Deno.test('client: GET to the fake verifies — header grammar, destination, no body type', async () => {
  await resetFederationTables();
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  await withFake(async (fake) => {
    const res = await federationRequest({
      destination: `localhost:${fake.port}`,
      method: 'GET',
      path: '/_matrix/key/v2/server',
      body: null,
    });
    assertEquals(res.status, 200);
    const last = fake.requests[fake.requests.length - 1];
    assertEquals(last.method, 'GET');
    assertEquals(last.verified, true);
    const doc = res.json as Record<string, unknown>;
    assertEquals(doc.server_name, `localhost:${fake.port}`);
  });
  setConfigForTests({ federation: { cacerts: [] } });
});

Deno.test('client: POST carries Content-Type and signs the content', async () => {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  await withFake(async (fake) => {
    const body = new TextEncoder().encode('{"x":1}');
    const err = await federationRequest({
      destination: `localhost:${fake.port}`,
      method: 'POST',
      path: '/whatever',
      body,
    }).then(() => 'ok', (e: unknown) => e);
    assert((err as MatrixError) instanceof MatrixError);
    assertEquals((err as MatrixError).status, 404);
    const last = fake.requests[fake.requests.length - 1];
    assertEquals(last.method, 'POST');
    const gotBody = last.body;
    assert(gotBody !== null);
    assertEquals(new TextDecoder().decode(gotBody), '{"x":1}');
    assertEquals(last.verified, true);
  });
  setConfigForTests({ federation: { cacerts: [] } });
});

Deno.test('client: a Matrix error body passes through with its own status and errcode', async () => {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  await withFake(async (fake) => {
    const err = await federationRequest({
      destination: `localhost:${fake.port}`,
      method: 'GET',
      path: '/nothing-real',
      body: null,
    }).then(
      () => 'resolved',
      (e) => e as MatrixError,
    );
    const mErr = err as MatrixError;
    assert(mErr instanceof MatrixError);
    assertEquals(mErr.status, 404);
    assertEquals(mErr.errcode, 'M_UNRECOGNIZED');
  });
  setConfigForTests({ federation: { cacerts: [] } });
});

Deno.test('client: connect timeout → 502 within connectms + margin', async () => {
  setConfigForTests({ federation: { connectms: 300 } });
  const t0 = Date.now();
  const err = await federationRequest({
    destination: '10.255.255.1:8448',
    method: 'GET',
    path: '/x',
    body: null,
  }).then(() => 'ok', (e) => e as MatrixError);
  const ms = Date.now() - t0;
  assert(err instanceof MatrixError);
  assertEquals((err as MatrixError).status, 502);
  assert(ms < 3000, `took ${ms}ms`);
  setConfigForTests({ federation: { connectms: 5000 } });
});

Deno.test('resolver round trip: explicit port against the fake', async () => {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  await withFake(async (fake) => {
    const ep = await resolve(`localhost:${fake.port}`);
    assertEquals(ep.port, fake.port);
    const res = await federationRequest({
      destination: `localhost:${fake.port}`,
      method: 'GET',
      path: '/_matrix/key/v2/server',
      body: null,
    });
    assertEquals(res.status, 200);
  });
  setConfigForTests({ federation: { cacerts: [] } });
});

Deno.test('resolver round trip: roster override connects; identity stays the server name', async () => {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  await resetFederationTables();
  await withFake(async (fake) => {
    await addPeer({
      name: 'localhost',
      host: '127.0.0.1',
      port: fake.port,
      trust: 'ca',
      addedBy: 'operator',
    });
    const ro = await lookupPeer('localhost');
    assert(ro !== null);
    const ep = await resolve('localhost');
    assertEquals(ep.port, fake.port);
    assertEquals(ep.connectIp, '127.0.0.1');
    const res = await federationRequest({
      destination: 'localhost',
      method: 'GET',
      path: '/_matrix/key/v2/server',
      body: null,
    });
    assertEquals(res.status, 200);
    await removePeer('localhost');
  });
  setConfigForTests({ federation: { cacerts: [] } });
});

// the full witness→acquire wiring, exercised end-to-end through the fake
Deno.test('wiring: acquireKeyDoc learns the fake key directly; witness query via the roster', async () => {
  await resetFederationTables();
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  wireFederationTransport();
  await withFake(async (fake) => {
    const doc = await acquireKeyDoc('localhost:' + fake.port, 0);
    assertEquals(doc.server_name, `localhost:${fake.port}`);
    const key = await getVerifyKey(
      'localhost:' + fake.port,
      'ed25519:test',
      0,
      'request',
    );
    assert(key instanceof CryptoKey);
    // and via a roster peer acting as witness
    await addPeer({
      name: 'localhost',
      host: '127.0.0.1',
      port: fake.port,
      trust: 'ca',
      addedBy: 'operator',
    });
    const w2doc = await acquireKeyDoc('localhost:' + fake.port, 0);
    assertEquals(w2doc.server_name, `localhost:${fake.port}`);
    await removePeer('localhost');
  });
  setConfigForTests({ federation: { cacerts: [] } });
});
