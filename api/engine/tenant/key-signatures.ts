// Verification and persistence share one tenant transaction for local targets.
// Remote target resolution belongs to client composition, outside this gate.
import type { Conn } from '#engine/store/db.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import { assertCanonicalNumbers } from '#engine/canonical.ts';
import {
  b64decode,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
} from '#engine/tenant/e2ee.ts';
import {
  keyMaterial,
  type SignatureSigner,
  signatureSigner,
  signatureView,
} from '#engine/tenant/signature-view.ts';
import { appendDeviceChange } from '#engine/tenant/changes.ts';
import { appendSigningChange } from '#engine/tenant/cross-signing.ts';
import { signingViews } from '#engine/tenant/cross-signing.ts';
import { encodeEnvelope } from '#engine/federation-envelope.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export type SignatureTarget = { user: string; id: string; json: Json };
const invalid = () => ({
  errcode: 'M_INVALID_SIGNATURE',
  error: 'signature, signer or target is invalid or changed',
});
export async function uploadSignatures(
  conn: Conn,
  localpart: string,
  user: string,
  targets: SignatureTarget[],
  limits: KeyLimits,
  maxEnvelopeBytes: number,
): Promise<Json> {
  const failures: Json = Object.create(null);
  for (const target of targets) {
    const fail = () => {
      if (!Object.hasOwn(failures, target.user)) {
        failures[target.user] = Object.create(null);
      }
      (failures[target.user] as Json)[target.id] = invalid();
    };
    // Local state is read and rechecked in the same transaction as the write.
    if (domainOf(target.user) !== domainOf(user)) {
      fail();
      continue;
    }
    const targetLocalpart = localpartOf(target.user);
    const masterRows = await conn.query(
      "SELECT key_json FROM cross_signing_keys WHERE localpart=? AND usage='master' AND key_id=?",
      [targetLocalpart, 'ed25519:' + target.id],
    );
    const deviceRows = masterRows.length || target.user !== user
      ? []
      : await conn.query(
        'SELECT k.key_json,k.generation FROM device_keys k JOIN devices d ON k.localpart=d.localpart AND k.device_id=d.device_id AND k.generation=d.generation WHERE k.localpart=? AND k.device_id=?',
        [targetLocalpart, target.id],
      );
    const row = masterRows[0] ?? deviceRows[0];
    if (
      !row ||
      keyMaterial(target.json) !== keyMaterial(JSON.parse(String(row.key_json)))
    ) {
      fail();
      continue;
    }
    const supplied = target.json.signatures;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
      fail();
      continue;
    }
    const own = (supplied as Json)[user];
    if (
      !own || typeof own !== 'object' || Array.isArray(own) ||
      !Object.keys(own).length
    ) {
      fail();
      continue;
    }
    const signers: { signer: SignatureSigner; signature: string }[] = [];
    let unchanged = 0;
    const stored = JSON.parse(String(row.key_json)) as Json;
    for (const [key, signature] of Object.entries(own)) {
      if (typeof signature !== 'string') continue;
      const usage = target.user !== user
        ? 'user_signing'
        : deviceRows.length
        ? 'self_signing'
        : null;
      const allowed = usage === null
        ? (await conn.query(
          'SELECT 1 FROM device_keys WHERE localpart=? AND device_id=?',
          [localpart, key.slice(8)],
        )).length > 0
        : (await conn.query(
          'SELECT 1 FROM cross_signing_keys WHERE localpart=? AND usage=? AND key_id=?',
          [localpart, usage, key],
        )).length > 0;
      if (!allowed) {
        const existing =
          ((stored.signatures as Json | undefined)?.[user] as Json | undefined)
            ?.[key];
        if (existing === signature) unchanged++;
        continue;
      }
      const signer = await signatureSigner(conn, localpart, key);
      if (!signer) continue;
      let valid = false;
      try {
        valid = await verifyJson(
          target.json,
          user,
          key,
          await importPublicKeyFromRaw(b64decode(signer.public)),
        );
      } catch { /* Bad key or signature. */ }
      if (valid) signers.push({ signer, signature });
    }
    // One bad supplied signature fails the target, without affecting other keys.
    if (
      !signers.length || signers.length + unchanged !== Object.keys(own).length
    ) {
      fail();
      continue;
    }
    const augmented = await signatureView(
      conn,
      JSON.parse(String(row.key_json)),
      target.user,
      target.id,
      user,
    );
    const signatures = augmented.signatures as Json;
    signatures[user] = {
      ...(signatures[user] as Json),
      ...Object.fromEntries(
        signers.map(({ signer, signature }) => [signer.key, signature]),
      ),
    };
    try {
      bounded(augmented, limits.maxkeybytes);
      if (target.user === user) {
        let content: Json;
        if (deviceRows.length) {
          content = {
            user_id: user,
            device_id: target.id,
            stream_id: Number.MAX_SAFE_INTEGER,
            prev_id: [Number.MAX_SAFE_INTEGER],
            keys: augmented,
          };
        } else {
          const views = await signingViews(conn, localpart, user, '');
          content = {
            user_id: user,
            master_key: augmented,
            ...(views.self_signing_keys
              ? { self_signing_key: views.self_signing_keys }
              : {}),
          };
        }
        bounded(
          JSON.parse(
            encodeEnvelope(domainOf(user)!, Number.MAX_SAFE_INTEGER, [], [{
              edu_type: deviceRows.length
                ? 'm.device_list_update'
                : 'm.signing_key_update',
              content,
            }]),
          ),
          maxEnvelopeBytes,
        );
      }
    } catch (error) {
      if (!(error instanceof MatrixError)) throw error;
      if (!Object.hasOwn(failures, target.user)) {
        failures[target.user] = Object.create(null);
      }
      (failures[target.user] as Json)[target.id] = {
        errcode: error.errcode,
        error: error.message,
      };
      continue;
    }
    let changed = false;
    for (const { signer, signature } of signers) {
      const old = await conn.query(
        'SELECT signer_basis,target_material,signature FROM key_signatures WHERE signer_localpart=? AND signer_key=? AND target_user=? AND target_key=?',
        [localpart, signer.key, target.user, target.id],
      );
      const material = keyMaterial(target.json);
      if (
        old.length && old[0].signer_basis === signer.basis &&
        old[0].target_material === material && old[0].signature === signature
      ) continue;
      await conn.execute(
        'INSERT INTO key_signatures VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(signer_localpart,signer_key,target_user,target_key) DO UPDATE SET signer_basis=excluded.signer_basis,target_material=excluded.target_material,signature=excluded.signature',
        [
          localpart,
          user,
          signer.key,
          signer.basis,
          target.user,
          target.id,
          material,
          signature,
        ],
      );
      changed = true;
    }
    if (!changed) continue;
    if (deviceRows.length) {
      await appendDeviceChange(conn, {
        localpart,
        deviceId: target.id,
        generation: Number(row.generation),
      });
    } else {
      await appendSigningChange(
        conn,
        localpart,
        user,
        target.user === user,
        maxEnvelopeBytes,
        target.user,
      );
    }
  }
  bounded(failures, limits.maxrequestbytes);
  return { failures };
}

export function signatureTargets(
  body: unknown,
  limits: KeyLimits,
): SignatureTarget[] {
  bounded(body, limits.maxrequestbytes);
  const targets: SignatureTarget[] = [];
  for (const [user, keys] of Object.entries(object(body, 'body'))) {
    for (const [id, value] of Object.entries(object(keys, 'target keys'))) {
      const json = object(value, 'signed target');
      bounded(json, limits.maxkeybytes);
      if (json.signatures !== undefined) {
        let count = 0;
        for (
          const signer of Object.values(object(json.signatures, 'signatures'))
        ) {
          count += Object.keys(object(signer, 'signer signatures')).length;
        }
        limitEntries(count, limits.maxkeys);
      }
      // Force canonical-number validation before opening a mutation transaction.
      assertCanonicalNumbers(json);
      targets.push({ user, id, json });
    }
  }
  limitEntries(targets.length, limits.maxkeys);
  return targets;
}
