// Tenant-owned overlays are bound to exact signed material and signer incarnation.
import type { Conn } from '#engine/store/db.ts';
import { keyView } from '#engine/e2ee-key-view.ts';
import { canonicalJson } from '#engine/canonical.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import {
  registryDevice,
  tenantAuthority,
} from '#engine/tenant/session-authority.ts';
import { publicDeviceValues } from '#engine/tenant/device-operations.ts';
import { signatureOperationOverlays } from '#engine/tenant/signature-operations.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';

export function keyMaterial(key: Json): string {
  const { signatures: _signatures, unsigned: _unsigned, ...body } = key;
  return canonicalJson(body);
}
export function remoteTargetMaterial(key: Json, revision: number): string {
  return canonicalJson([keyMaterial(key), revision]);
}
export type SignatureSigner = {
  key: string;
  public: string;
  basis: string;
  usage?: string;
};
export async function signatureSigner(
  conn: Conn,
  localpart: string,
  key: string,
): Promise<SignatureSigner | null> {
  const authority = await tenantAuthority(conn);
  const signing = await conn.query(
    'SELECT key_json,revision FROM cross_signing_keys WHERE localpart=? AND key_id=?',
    [localpart, key],
  );
  if (signing.length) {
    const json = JSON.parse(String(signing[0].key_json));
    return {
      key,
      public: String(json.keys[key]),
      basis: canonicalJson(
        authority
          ? [
            'signing',
            authority.homeIncarnation,
            keyMaterial(json),
            Number(signing[0].revision),
          ]
          : [keyMaterial(json), Number(signing[0].revision)],
      ),
      ...(authority ? { usage: String(json.usage[0]) } : {}),
    };
  }
  const devices = await conn.query(
    'SELECT k.key_json,k.generation FROM device_keys k JOIN devices d ON d.localpart=k.localpart AND d.device_id=k.device_id AND d.generation=k.generation WHERE k.localpart=? AND k.device_id=?',
    [localpart, key.slice(8)],
  );
  if (!key.startsWith('ed25519:')) return null;
  if (authority) {
    const creation = await registryDevice(conn, localpart, key.slice(8));
    const [mapping] = await conn.query(
      'SELECT incarnation FROM authority_devices WHERE localpart=? AND device_id=?',
      [localpart, key.slice(8)],
    );
    const local = devices.length && mapping?.incarnation === creation?.id
      ? JSON.parse(String(devices[0].key_json)) as Json
      : null;
    const imported = local
      ? null
      : (await publicDeviceValues(conn, localpart)).find((op) =>
        op.deviceId === key.slice(8)
      )?.value?.keys;
    const json = local ?? imported;
    if (!json || !creation || typeof (json.keys as Json)[key] !== 'string') {
      return null;
    }
    return {
      key,
      public: String((json.keys as Json)[key]),
      basis: canonicalJson(['device', creation.id, keyMaterial(json)]),
      usage: 'device',
    };
  }
  if (!devices.length) return null;
  const json = JSON.parse(String(devices[0].key_json));
  if (typeof json.keys[key] !== 'string') return null;
  return {
    key,
    public: json.keys[key],
    basis: canonicalJson([keyMaterial(json), Number(devices[0].generation)]),
  };
}

/** F2 identities use source-stable incarnations/revisions, never another
 * store's local device generation or remote-cache counter. */
export async function signatureTargetMaterial(
  conn: Conn,
  key: Json,
  owner: string,
  target: string,
): Promise<string> {
  const authority = await tenantAuthority(conn);
  if (!authority) return keyMaterial(key);
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  if (domainOf(owner) !== tenant.server_name) {
    return canonicalJson(['remote', keyMaterial(key)]);
  }
  const localpart = localpartOf(owner);
  const [signing] = await conn.query(
    'SELECT revision FROM cross_signing_keys WHERE localpart=? AND key_id=?',
    [localpart, 'ed25519:' + target],
  );
  if (signing) {
    return canonicalJson([
      'signing',
      authority.homeIncarnation,
      keyMaterial(key),
      Number(signing.revision),
    ]);
  }
  const creation = await registryDevice(conn, localpart, target);
  return canonicalJson(['device', creation?.id ?? null, keyMaterial(key)]);
}
export async function signatureView(
  conn: Conn,
  key: Json,
  owner: string,
  target: string,
  requester?: string,
  material?: string,
): Promise<Json> {
  const authority = await tenantAuthority(conn);
  material = authority
    ? await signatureTargetMaterial(conn, key, owner, target)
    : material ?? keyMaterial(key);
  const result = keyView(key, owner, requester);
  const signatures = result.signatures as Json;
  // Uploaded key bodies can contain signatures too. An embedded overlay must
  // not bypass current signer authorization after rotation or device deletion.
  // Remote owners' public signatures remain their ordinary federation evidence.
  if (authority) {
    const [tenant] = await conn.query('SELECT server_name FROM tenant');
    const usage = Array.isArray(key.usage) && key.usage.length === 1
      ? key.usage[0]
      : null;
    for (const [user, raw] of Object.entries(signatures)) {
      if (domainOf(user) !== tenant.server_name) continue;
      const held: Json = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [id, signature] of Object.entries(raw)) {
          if (typeof signature !== 'string') continue;
          const signer = await signatureSigner(conn, localpartOf(user), id);
          if (!signer) continue;
          // Mutable overlays require their original admission basis below. Only
          // intrinsic identity/self signatures may come directly from a body.
          const allowed = user !== owner
            ? false
            : usage === 'master'
            ? signer.usage === 'master' && id === 'ed25519:' + target
            : usage === 'self_signing' || usage === 'user_signing'
            ? signer.usage === 'master'
            : signer.usage === 'device' && id === 'ed25519:' + target;
          if (!allowed) continue;
          try {
            if (
              await verifyJson(
                key,
                user,
                id,
                await importPublicKeyFromRaw(matrixBase64(signer.public, 32)),
              )
            ) held[id] = signature;
          } catch {
            /* Unverified embedded overlays carry no signature authority. */
          }
        }
      }
      if (Object.keys(held).length) signatures[user] = held;
      else delete signatures[user];
    }
  }
  for (
    const row of await conn.query(
      'SELECT signer_localpart,signer_user,signer_key,signer_basis,signature FROM key_signatures WHERE target_user=? AND target_key=? AND target_material=? AND (signer_user=? OR signer_user=?)',
      [owner, target, material, owner, requester ?? ''],
    )
  ) {
    const signer = await signatureSigner(
      conn,
      String(row.signer_localpart),
      String(row.signer_key),
    );
    if (signer?.basis !== row.signer_basis) continue;
    const user = String(row.signer_user);
    signatures[user] = {
      ...(signatures[user] as Json),
      [String(row.signer_key)]: row.signature,
    };
  }
  if (authority) {
    for (
      const operation of await signatureOperationOverlays(
        conn,
        owner,
        target,
        material,
      )
    ) {
      const user = '@' + operation.localpart + ':' +
        (await conn.query('SELECT server_name FROM tenant'))[0].server_name;
      if (user !== owner && user !== requester) continue;
      if (keyMaterial(operation.target.json) !== keyMaterial(key)) continue;
      const [account] = await conn.query(
        'SELECT deactivated FROM users WHERE localpart=?',
        [operation.localpart],
      );
      if (!account || account.deactivated === 1) continue;
      for (const held of operation.signers) {
        const signer = await signatureSigner(
          conn,
          operation.localpart,
          held.signer.key,
        );
        if (
          !signer || signer.basis !== held.signer.basis ||
          signer.public !== held.signer.public
        ) continue;
        const usage = Array.isArray(key.usage) && key.usage.length === 1
          ? key.usage[0]
          : null;
        if (
          user !== owner
            ? usage !== 'master' || signer.usage !== 'user_signing'
            : usage === 'master'
            ? signer.usage !== 'device'
            : usage !== null || signer.usage !== 'self_signing'
        ) continue;
        signatures[user] = {
          ...(signatures[user] as Json),
          [signer.key]: held.signature,
        };
      }
    }
  }
  return result;
}
export async function forgetKeySignatures(
  conn: Conn,
  user: string,
  id: string,
): Promise<boolean> {
  const localpart = localpartOf(user);
  const keys = await conn.query(
    "SELECT key_id,key_json FROM cross_signing_keys WHERE localpart=? AND usage IN ('master','self_signing') ORDER BY usage",
    [localpart],
  );
  const publicView = async () =>
    canonicalJson(
      await Promise.all(keys.map(async (row) =>
        await signatureView(
          conn,
          JSON.parse(String(row.key_json)),
          user,
          String(row.key_id).slice(8),
        )
      )),
    );
  const before = await publicView();
  await conn.execute(
    'DELETE FROM key_signatures WHERE (target_user=? AND target_key=?) OR (signer_localpart=? AND signer_key=?)',
    [user, id, localpartOf(user), 'ed25519:' + id],
  );
  return before !== await publicView();
}
