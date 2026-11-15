// The explicit standalone -> F2 transition pins already verified overlays before
// their generation-local bases are replaced by global device incarnations.
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import type { PublicSigning } from '#engine/e2ee-public-signing.ts';
import {
  appendSignatureOperation,
  captureEmbeddedSignatures,
} from '#engine/tenant/signature-operations.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import {
  keyMaterial,
  remoteTargetMaterial,
  signatureSigner,
  signatureTargetMaterial,
} from '#engine/tenant/signature-view.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';

type LegacySignature = {
  localpart: string;
  user: string;
  key: string;
  public: string;
  target: { user: string; id: string; json: Json };
  signature: string;
};

export type RemoteSignatureCuts = ReadonlyMap<
  string,
  { revision: number; keys: PublicSigning }
>;
/** Composition retries with the newly observed subject, outside this file gate. */
export class RemoteSignatureCutMissing extends Error {}

/** Read BEFORE tenant_authority installation, while the old owner can still
 * prove exact target material and the original local generation/revision. */
export async function legacySignatures(
  conn: Conn,
  remotes: RemoteSignatureCuts = new Map(),
): Promise<LegacySignature[]> {
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  const result: LegacySignature[] = [];
  for (
    const row of await conn.query(
      'SELECT * FROM key_signatures ORDER BY signer_localpart,signer_key,target_user,target_key',
    )
  ) {
    const localpart = String(row.signer_localpart);
    const user = '@' + localpart + ':' + tenant.server_name;
    const key = String(row.signer_key);
    const signer = await signatureSigner(conn, localpart, key);
    if (
      !signer || row.signer_user !== user || signer.basis !== row.signer_basis
    ) continue;
    const owner = String(row.target_user), id = String(row.target_key);
    let json: Json | undefined;
    if (domainOf(owner) === tenant.server_name) {
      const targetLocalpart = localpartOf(owner);
      const [target] = await conn.query(
        'SELECT key_json FROM cross_signing_keys WHERE localpart=? AND key_id=? UNION ALL SELECT k.key_json FROM device_keys k JOIN devices d ON d.localpart=k.localpart AND d.device_id=k.device_id AND d.generation=k.generation WHERE k.localpart=? AND k.device_id=?',
        [targetLocalpart, 'ed25519:' + id, targetLocalpart, id],
      );
      if (target) {
        const parsed = JSON.parse(String(target.key_json)) as Json;
        if (keyMaterial(parsed) === row.target_material) json = parsed;
      }
    } else {
      // A stored tuple proves the original admission, not current visibility.
      // Composition pins this current cache cut above both file transactions.
      const state = remotes.get(owner);
      if (!state) throw new RemoteSignatureCutMissing(owner);
      const target = state.keys.master_key;
      if (
        target && Object.hasOwn(target.keys as Json, 'ed25519:' + id) &&
        remoteTargetMaterial(target, state.revision) === row.target_material
      ) json = target;
    }
    if (!json) continue;
    const signature = String(row.signature);
    try {
      if (
        !await verifyJson(
          { ...json, signatures: { [user]: { [key]: signature } } },
          user,
          key,
          await importPublicKeyFromRaw(matrixBase64(signer.public, 32)),
        )
      ) continue;
    } catch {
      continue;
    }
    result.push({
      localpart,
      user,
      key,
      public: signer.public,
      target: { user: owner, id, json: JSON.parse(keyMaterial(json)) },
      signature,
    });
  }
  return result;
}

/** Called once in the SAME activation transaction, after pre-enrollment device
 * incarnations exist. Replaying activation never reauthors or rebinds these. */
export async function retainLegacySignatures(
  conn: Conn,
  legacy: LegacySignature[],
) {
  if ((await tenantAuthority(conn))?.node !== 'home') return;
  for (const held of legacy) {
    const signer = await signatureSigner(conn, held.localpart, held.key);
    if (!signer || signer.public !== held.public) {
      throw new Error('signature bootstrap signer changed');
    }
    const operation = await appendSignatureOperation(conn, held.localpart, {
      ...held.target,
      material: await signatureTargetMaterial(
        conn,
        held.target.json,
        held.target.user,
        held.target.id,
      ),
    }, [{ signer, signature: held.signature }]);
    if (!operation) throw new Error('signature bootstrap awaits authority');
    // Preserve the ordinary owner index too; both paths now name the same fact.
    await conn.execute(
      'UPDATE key_signatures SET signer_basis=?,target_material=? WHERE signer_localpart=? AND signer_key=? AND target_user=? AND target_key=? AND signature=?',
      [
        signer.basis,
        operation.target.material,
        held.localpart,
        held.key,
        held.target.user,
        held.target.id,
        held.signature,
      ],
    );
    if (
      canonicalJson(operation.target.json) !== keyMaterial(held.target.json)
    ) throw new Error('signature bootstrap material changed');
  }
  // Pin currently held embedded overlays at the activation cut too. Deferring
  // this until the first export would let a later same-key device recreation
  // relabel an old body with its replacement's incarnation.
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  for (
    const row of await conn.query(
      'SELECT localpart,key_id,key_json FROM cross_signing_keys ORDER BY localpart,usage',
    )
  ) {
    await captureEmbeddedSignatures(
      conn,
      String(row.localpart),
      '@' + row.localpart + ':' + tenant.server_name,
      String(row.key_id).slice(8),
      JSON.parse(String(row.key_json)),
    );
  }
  for (
    const row of await conn.query(
      'SELECT k.localpart,k.device_id,k.key_json FROM device_keys k JOIN devices d ON d.localpart=k.localpart AND d.device_id=k.device_id AND d.generation=k.generation ORDER BY k.localpart,k.device_id',
    )
  ) {
    await captureEmbeddedSignatures(
      conn,
      String(row.localpart),
      '@' + row.localpart + ':' + tenant.server_name,
      String(row.device_id),
      JSON.parse(String(row.key_json)),
    );
  }
}
