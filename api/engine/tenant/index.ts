// api/engine/tenant/index.ts — the typed tenant handle: one tenant file,
// holding the tenant's identity (generate-once ed25519 keypair, never
// silently rotated), the native server name derived from the key, and the
// event signer (stage 3b's Signer). The store must have been opened with
// the tenant schema provider (R14).
import type { Store } from '#engine/store/index.ts';
import type { Signer } from '#engine/room/signer.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import {
  b32encode,
  b64decode,
  b64encodeStd,
  exportPrivateKeyPkcs8,
  exportPublicKeyRaw,
  generateSigningKeypair,
  importPrivateKeyFromPkcs8,
  importPublicKeyFromRaw,
} from '#engine/signing-primitives.js';

export { tenantSchema };

// Native server name: the tenant key as lowercase unpadded base32, one
// DNS label (52 chars for ed25519) — as in doltgres:api/engine/tenant.ts.
export function nativeNameFor(pubRaw: Uint8Array): string {
  return b32encode(pubRaw).replace(/=+$/, '').toLowerCase();
}

export type Tenant = {
  // The server name the tenant file was opened with.
  readonly serverName: string;
  // The key-derived native name (base32 of the public key).
  readonly nativeName: string;
  // The full key id ('ed25519:…'), used verbatim as the signatures key.
  readonly keyId: string;
  // The public key, standard base64 unpadded.
  readonly publicB64: string;
  // The real event signer (stage 3b) from the tenant key.
  signer(): Signer;
};

type IdentityRow = {
  server_name: string;
  native_name: string;
  pubkey_b64: string;
  privkey_enc: string;
  key_id: string;
};

export async function openTenant(
  store: Store,
  serverName: string,
  options: { create?: boolean } = {},
): Promise<Tenant> {
  const db = await store.tenant(serverName, options);
  const { row, privateKey } = await db.tx(async (conn) => {
    const rows = await conn.query(
      'SELECT server_name, native_name, pubkey_b64, privkey_enc, key_id FROM tenant WHERE server_name = ?',
      [serverName],
    );
    if (rows.length > 0) {
      const row = rows[0] as unknown as IdentityRow;
      return {
        row,
        privateKey: await importPrivateKeyFromPkcs8(
          b64decode(String(row.privkey_enc)),
        ),
      };
    }
    const pair = (await generateSigningKeypair()) as CryptoKeyPair;
    const pubRaw = await exportPublicKeyRaw(pair.publicKey);
    const privDer = await exportPrivateKeyPkcs8(pair.privateKey);
    const row: IdentityRow = {
      server_name: serverName,
      native_name: nativeNameFor(pubRaw),
      pubkey_b64: b64encodeStd(pubRaw),
      privkey_enc: b64encodeStd(privDer),
      key_id: '1',
    };
    await conn.execute(
      'INSERT INTO tenant (server_name, native_name, pubkey_b64, privkey_enc, key_id, created_ms) VALUES (?, ?, ?, ?, ?, ?)',
      [
        row.server_name,
        row.native_name,
        row.pubkey_b64,
        row.privkey_enc,
        row.key_id,
        Date.now(),
      ],
    );
    return { row, privateKey: pair.privateKey };
  });
  // The public key is verified loadable once at open; the signer closes
  // over both halves.
  await importPublicKeyFromRaw(b64decode(String(row.pubkey_b64)));
  return {
    serverName,
    nativeName: String(row.native_name),
    keyId: 'ed25519:' + String(row.key_id),
    publicB64: String(row.pubkey_b64),
    signer: () => ({
      serverName,
      keyId: 'ed25519:' + String(row.key_id),
      sign: async (canonical: string) => {
        const signature = await crypto.subtle.sign(
          { name: 'Ed25519' },
          privateKey,
          new TextEncoder().encode(canonical),
        );
        return b64encodeStd(new Uint8Array(signature));
      },
    }),
  };
}
