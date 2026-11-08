// Tenant-owned overlays are bound to exact signed material and signer incarnation.
import type { Conn } from '#engine/store/db.ts';
import { keyView } from '#engine/e2ee-key-view.ts';
import { canonicalJson } from '#engine/canonical.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import { localpartOf } from '#engine/ids.ts';

export function keyMaterial(key: Json): string {
  const { signatures: _signatures, unsigned: _unsigned, ...body } = key;
  return canonicalJson(body);
}
export function remoteTargetMaterial(key: Json, revision: number): string {
  return canonicalJson([keyMaterial(key), revision]);
}
export type SignatureSigner = { key: string; public: string; basis: string };
export async function signatureSigner(
  conn: Conn,
  localpart: string,
  key: string,
): Promise<SignatureSigner | null> {
  const signing = await conn.query(
    'SELECT key_json,revision FROM cross_signing_keys WHERE localpart=? AND key_id=?',
    [localpart, key],
  );
  if (signing.length) {
    const json = JSON.parse(String(signing[0].key_json));
    return {
      key,
      public: String(json.keys[key]),
      basis: canonicalJson([keyMaterial(json), Number(signing[0].revision)]),
    };
  }
  const devices = await conn.query(
    'SELECT k.key_json,k.generation FROM device_keys k JOIN devices d ON d.localpart=k.localpart AND d.device_id=k.device_id AND d.generation=k.generation WHERE k.localpart=? AND k.device_id=?',
    [localpart, key.slice(8)],
  );
  if (!devices.length || !key.startsWith('ed25519:')) return null;
  const json = JSON.parse(String(devices[0].key_json));
  if (typeof json.keys[key] !== 'string') return null;
  return {
    key,
    public: json.keys[key],
    basis: canonicalJson([keyMaterial(json), Number(devices[0].generation)]),
  };
}
export async function signatureView(
  conn: Conn,
  key: Json,
  owner: string,
  target: string,
  requester?: string,
  material = keyMaterial(key),
): Promise<Json> {
  const result = keyView(key, owner, requester);
  const signatures = result.signatures as Json;
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
  return result;
}
export async function forgetKeySignatures(
  conn: Conn,
  user: string,
  id: string,
): Promise<void> {
  await conn.execute(
    'DELETE FROM key_signatures WHERE (target_user=? AND target_key=?) OR (signer_localpart=? AND signer_key=?)',
    [user, id, localpartOf(user), 'ed25519:' + id],
  );
}
