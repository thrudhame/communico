// tests/fixtures/signer.ts — a fixed test signer: one deterministic
// ed25519 key (a constant seed), so signatures are stable across runs.
import {
  b64encodeStd,
  generateSigningKeypair,
  importPrivateKeyFromSeed,
} from '#engine/signing-primitives.js';
import type { Signer } from '#engine/room/signer.ts';
import type { RemoteServer } from '#tests/fixtures/remote.ts';

export async function testSigner(serverName = 'test'): Promise<Signer> {
  const key = await importPrivateKeyFromSeed(new Uint8Array(32).fill(7));
  return {
    serverName,
    keyId: 'ed25519:test',
    sign: async (canonical: string) => {
      const sig = await crypto.subtle.sign(
        { name: 'Ed25519' },
        key,
        new TextEncoder().encode(canonical),
      );
      return b64encodeStd(new Uint8Array(sig));
    },
  };
}

// The same key as a RemoteServer, so the fake KeyResolver can verify
// OUR OWN events riding a snapshot/page back to us (the stage-4 key
// store will cover the tenant key the same way).
export async function testRemoteServer(
  serverName = 'test',
): Promise<RemoteServer> {
  const privateKey = await importPrivateKeyFromSeed(
    new Uint8Array(32).fill(7),
  );
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
    { name: 'Ed25519' },
    true,
    ['verify'],
  );
  return {
    name: serverName,
    keyId: 'ed25519:test',
    kp: { privateKey, publicKey },
  };
}

// A random keypair with its public half, for tests that verify the
// signature a build produces.
export async function randomSigner(
  serverName = 'test',
): Promise<{ signer: Signer; publicKey: CryptoKey }> {
  const pair = (await generateSigningKeypair()) as CryptoKeyPair;
  return {
    publicKey: pair.publicKey,
    signer: {
      serverName,
      keyId: 'ed25519:test',
      sign: async (canonical: string) => {
        const sig = await crypto.subtle.sign(
          { name: 'Ed25519' },
          pair.privateKey,
          new TextEncoder().encode(canonical),
        );
        return b64encodeStd(new Uint8Array(sig));
      },
    },
  };
}
