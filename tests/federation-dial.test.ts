// tests/federation-dial.test.ts — the node:tls dialer: pinned peers match
// the roster SPKI hash; mismatches are a 502 before any request bytes are
// written; key-is-name peers match the raw 32-byte key equality.
import { assert, assertEquals } from '@std/assert';
import { createHash, X509Certificate } from 'node:crypto';
import { MatrixError } from '#engine/matrix-error.ts';
import { addPeer, removePeer } from '#engine/federation/peers.ts';
import { federationRequest } from '#engine/federation/client.ts';
import {
  b32encode,
  exportPublicKeyRaw,
  generateSigningKeypair,
} from '#engine/signing-primitives.js';
import { resetFederationTables } from './util.ts';

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
  await resetFederationTables();
  const pem = await Deno.readTextFile('tests/fixtures/tls/localhost.crt');
  const key = await Deno.readTextFile('tests/fixtures/tls/localhost.key');
  const pin = pinOf(pem);
  await withTlsFake(pem, key, async (port) => {
    await addPeer({
      name: 'localhost',
      host: '127.0.0.1',
      port,
      trust: 'pinned',
      pin,
      addedBy: 'operator',
    });
    const ok = await federationRequest({
      destination: 'localhost',
      method: 'GET',
      path: '/x',
      body: null,
    });
    assertEquals(ok.status, 200);
    await removePeer('localhost');
    // wrong pin → 502 with the pin message
    await addPeer({
      name: 'localhost',
      host: '127.0.0.1',
      port,
      trust: 'pinned',
      pin: 'f'.repeat(64),
      addedBy: 'operator',
    });
    const err = await federationRequest({
      destination: 'localhost',
      method: 'GET',
      path: '/x',
      body: null,
    }).then(() => 'ok', (e: unknown) => e as MatrixError);
    assert((err as MatrixError) instanceof MatrixError);
    assertEquals((err as MatrixError).status, 502);
    assert((err as MatrixError).message.includes('pin'));
    await removePeer('localhost');
  });
});

Deno.test('dial: key-is-name peer → raw key equality round trips', async () => {
  await resetFederationTables();
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
    await addPeer({
      name,
      host: '127.0.0.1',
      port,
      trust: 'keyname',
      addedBy: 'operator',
    });
    const ok = await federationRequest({
      destination: name,
      method: 'GET',
      path: '/x',
      body: null,
    });
    assertEquals(ok.status, 200);
    await removePeer(name);
    // a wrong raw key → 502 with the key message
    const other = (await generateSigningKeypair()) as unknown as CryptoKeyPair;
    const otherRaw = await exportPublicKeyRaw(other.publicKey);
    const otherName = b32encode(otherRaw).toLowerCase().replace(/=+$/, '');
    await addPeer({
      name: otherName,
      host: '127.0.0.1',
      port,
      trust: 'keyname',
      addedBy: 'operator',
    });
    const err = await federationRequest({
      destination: otherName,
      method: 'GET',
      path: '/x',
      body: null,
    }).then(() => 'ok', (e: unknown) => e as MatrixError);
    assert((err as MatrixError) instanceof MatrixError);
    assertEquals((err as MatrixError).status, 502);
    assert((err as MatrixError).message.includes('key'));
    await removePeer(otherName);
  });
});
