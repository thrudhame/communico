// api/engine/tenant/index.ts — the typed tenant handle: one tenant file,
// holding the tenant's identity (generate-once ed25519 keypair, never
// silently rotated), the native server name derived from the key, and the
// event signer (stage 3b's Signer). One transaction per tx() call, every
// data operation exposed inside it under its module's short name. The
// store must have been opened with the tenant schema provider (R14).
import type { Store } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Signer } from '#engine/room/signer.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import * as auth from '#engine/tenant/auth.ts';
import * as devices from '#engine/tenant/devices.ts';
import * as pushers from '#engine/tenant/pushers.ts';
import * as uia from '#engine/tenant/uia.ts';
import * as users from '#engine/tenant/users.ts';
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
export type { DeviceRow } from '#engine/tenant/devices.ts';
export type { ProfileRow } from '#engine/tenant/users.ts';
export type { UiaSession } from '#engine/tenant/uia.ts';

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
  tx<T>(fn: (tenant: TenantTx) => Promise<T>): Promise<T>;
};

type IdentityRow = {
  server_name: string;
  native_name: string;
  pubkey_b64: string;
  privkey_enc: string;
  key_id: string;
};

function bind(conn: Conn) {
  return {
    users: {
      exists: (localpart: string) => users.userExists(conn, localpart),
      insert: (localpart: string, displayName: string) =>
        users.insertUser(conn, localpart, displayName),
      byLocalpart: (localpart: string) =>
        users.userByLocalpart(conn, localpart),
      setDisplayName: (localpart: string, name: string | null) =>
        users.setUserDisplayName(conn, localpart, name),
      setAvatarUrl: (localpart: string, url: string | null) =>
        users.setUserAvatarUrl(conn, localpart, url),
      markDeactivated: (localpart: string) =>
        users.markDeactivated(conn, localpart),
    },
    credentials: {
      set: (localpart: string, phc: string) =>
        users.setCredential(conn, localpart, phc),
      hash: (localpart: string) => users.credentialHash(conn, localpart),
    },
    devices: {
      upsert: (
        deviceId: string,
        localpart: string,
        displayName: string | null,
      ) => devices.upsertDeviceRow(conn, deviceId, localpart, displayName),
      byId: (deviceId: string, localpart: string) =>
        devices.deviceById(conn, deviceId, localpart),
      ofUser: (localpart: string) => devices.devicesOfUser(conn, localpart),
      rename: (deviceId: string, localpart: string, displayName: string) =>
        devices.renameDevice(conn, deviceId, localpart, displayName),
      delete: (deviceId: string) => devices.deleteDevice(conn, deviceId),
      deleteOwned: (deviceId: string, localpart: string) =>
        devices.deleteDeviceOwned(conn, deviceId, localpart),
      deleteForUser: (localpart: string) =>
        devices.deleteDevicesOfUser(conn, localpart),
    },
    tokens: {
      insert: (
        hash: string,
        localpart: string,
        deviceId: string | null,
        expiresMs: number | null,
      ) => auth.insertAccessToken(conn, hash, localpart, deviceId, expiresMs),
      byHash: (hash: string) => auth.accessTokenByHash(conn, hash),
      ofUser: (localpart: string) => auth.accessTokensOfUser(conn, localpart),
      ofDevice: (deviceId: string) => auth.accessTokensOfDevice(conn, deviceId),
      delete: (hash: string) => auth.deleteAccessToken(conn, hash),
      deleteForUser: (localpart: string) =>
        auth.deleteAccessTokensOfUser(conn, localpart),
    },
    refresh: {
      insert: (
        hash: string,
        localpart: string,
        deviceId: string | null,
        accessHash: string,
      ) => auth.insertRefreshToken(conn, hash, localpart, deviceId, accessHash),
      byHash: (hash: string) => auth.refreshTokenByHash(conn, hash),
      delete: (hash: string) => auth.deleteRefreshToken(conn, hash),
      deleteForAccessToken: (accessHash: string) =>
        auth.deleteRefreshForAccessToken(conn, accessHash),
      deleteForUser: (localpart: string) =>
        auth.deleteRefreshTokensOfUser(conn, localpart),
    },
    uia: {
      insert: (session: string, flows: { stages: string[] }[]) =>
        uia.insertUiaSession(conn, session, flows),
      byId: (session: string) => uia.uiaSessionById(conn, session),
      complete: (session: string, stages: string[]) =>
        uia.completeUiaSessionStages(conn, session, stages),
      drop: (session: string) => uia.deleteUiaSession(conn, session),
    },
    pushers: {
      deleteForToken: (accessHash: string) =>
        pushers.deletePushersForToken(conn, accessHash),
      deleteForUser: (localpart: string) =>
        pushers.deletePushersOfUser(conn, localpart),
    },
  };
}

export type TenantTx = ReturnType<typeof bind>;

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
    tx: (fn) => db.tx((conn) => fn(bind(conn))),
  };
}
