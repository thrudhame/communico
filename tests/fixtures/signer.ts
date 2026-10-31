// tests/fixtures/signer.ts — a fixed test signer: one deterministic
// ed25519 key (a constant seed), so signatures are stable across runs.
// Nothing verifies in 3b, so no public key is needed.
import {
  b64encodeStd,
  importPrivateKeyFromSeed,
} from '#engine/signing-primitives.js';
import type { Signer } from '#engine/room/signer.ts';

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
