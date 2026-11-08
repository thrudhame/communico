// The tenant owns key rotation, collision checks and the immutable change intent.
import type { Conn } from '#engine/store/db.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import {
  type SigningUpload,
  signingUsages,
  verifySigningKey,
} from '#engine/e2ee-signing.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import { bounded } from '#engine/tenant/e2ee.ts';
import { encodeEnvelope } from '#engine/federation-envelope.ts';
import { domainOf } from '#engine/ids.ts';
import {
  forgetKeySignatures,
  signatureView,
} from '#engine/tenant/signature-view.ts';

export async function signingState(
  conn: Conn,
  localpart: string,
): Promise<SigningUpload> {
  const keys: SigningUpload = {};
  for (
    const row of await conn.query(
      'SELECT usage,key_id,key_json FROM cross_signing_keys WHERE localpart=?',
      [localpart],
    )
  ) {
    const usage = signingUsages.find((u) => u === row.usage);
    if (!usage) throw new Error('unknown stored signing usage');
    keys[usage] = {
      id: String(row.key_id),
      public: String(row.key_id).slice(8),
      json: String(row.key_json),
    };
  }
  return keys;
}
export function needsSigningAuth(
  old: SigningUpload,
  input: SigningUpload,
): boolean {
  return old.master !== undefined &&
    (input.master === undefined || input.master.json !== old.master.json ||
      signingUsages.some((u) =>
        input[u] !== undefined && input[u]!.json !== old[u]?.json
      ));
}
export async function signingCollision(
  conn: Conn,
  localpart: string,
  deviceId: string,
): Promise<void> {
  if (
    (await conn.query(
      'SELECT 1 FROM cross_signing_keys WHERE localpart=? AND key_id=? LIMIT 1',
      [localpart, 'ed25519:' + deviceId],
    )).length
  ) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'device ID is a cross-signing key',
    );
  }
}
export async function signingViews(
  conn: Conn,
  localpart: string,
  user: string,
  requester: string,
): Promise<Json> {
  const state = await signingState(conn, localpart), result: Json = {};
  for (const usage of signingUsages) {
    if (usage === 'user_signing' && requester !== user) continue;
    if (state[usage]) {
      result[usage + '_keys'] = await signatureView(
        conn,
        JSON.parse(state[usage]!.json),
        user,
        state[usage]!.public,
        requester,
      );
    }
  }
  return result;
}
export async function uploadSigningKeys(
  conn: Conn,
  localpart: string,
  user: string,
  input: SigningUpload,
  basis: string,
  authenticated: boolean,
  maxEnvelopeBytes: number,
): Promise<void> {
  const old = await signingState(conn, localpart);
  if (
    needsSigningAuth(old, input) &&
    (!authenticated || canonicalJson(old) !== basis)
  ) {
    // A concurrent first upload or rotation must never inherit an earlier skip/UIA.
    throw new MatrixError(
      409,
      'M_CONFLICT',
      'signing keys changed; authenticate the current key set again',
    );
  }
  const master = input.master ?? old.master;
  if (!master && Object.keys(input).length) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'master key is required');
  }
  for (const usage of signingUsages) {
    const key = input[usage];
    if (!key) continue;
    if (
      (await conn.query(
        'SELECT 1 FROM devices WHERE localpart=? AND device_id=?',
        [localpart, key.public],
      )).length
    ) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'signing key ID is a device');
    }
    if (
      usage !== 'master' &&
      !await verifySigningKey(JSON.parse(key.json), user, master!)
    ) {
      throw new MatrixError(
        400,
        'M_INVALID_SIGNATURE',
        'subordinate key is not signed by the master',
      );
    }
  }
  const next = { ...old, ...input };
  if (input.master && input.master.public !== old.master?.public) {
    for (const usage of ['self_signing', 'user_signing'] as const) {
      if (!input[usage]) delete next[usage];
    }
  }
  if (canonicalJson(next) === canonicalJson(old)) return;
  const revisions = await conn.query(
    'SELECT usage,revision FROM cross_signing_keys WHERE localpart=?',
    [localpart],
  );
  for (const usage of signingUsages) {
    if (old[usage] && old[usage]!.json !== next[usage]?.json) {
      await forgetKeySignatures(conn, user, old[usage]!.public);
    }
  }
  const revision = await nextCounter(conn, 'cross_signing');
  await conn.execute('DELETE FROM cross_signing_keys WHERE localpart=?', [
    localpart,
  ]);
  for (const usage of signingUsages) {
    const key = next[usage];
    if (key) {
      await conn.execute('INSERT INTO cross_signing_keys VALUES(?,?,?,?,?)', [
        localpart,
        usage,
        key.id,
        key.json,
        old[usage]?.json === key.json
          ? Number(revisions.find((row) => row.usage === usage)!.revision)
          : revision,
      ]);
    }
  }
  const publicChanged = ['master', 'self_signing'].some((u) =>
    old[u as keyof SigningUpload]?.json !== next[u as keyof SigningUpload]?.json
  );
  await appendSigningChange(
    conn,
    localpart,
    user,
    publicChanged,
    maxEnvelopeBytes,
  );
}

export async function appendSigningChange(
  conn: Conn,
  localpart: string,
  user: string,
  publicChanged: boolean,
  maxEnvelopeBytes: number,
  subject = user,
): Promise<void> {
  const next = await signingState(conn, localpart);
  const payload: Json = {
    kind: publicChanged ? 'public_signing' : 'private_signing',
    ...(publicChanged ? {} : { subject }),
  };
  if (publicChanged) {
    for (const usage of ['master', 'self_signing'] as const) {
      if (next[usage]) {
        payload[usage + '_key'] = await signatureView(
          conn,
          JSON.parse(next[usage]!.json),
          user,
          next[usage]!.public,
        );
      }
    }
    const { kind: _kind, ...publicKeys } = payload;
    bounded(
      JSON.parse(encodeEnvelope(domainOf(user)!, Number.MAX_SAFE_INTEGER, [], [{
        edu_type: 'm.signing_key_update',
        content: { ...publicKeys, user_id: user },
      }])),
      maxEnvelopeBytes,
    );
  }
  const pos = await nextCounter(conn, 'e2ee_changes');
  await conn.execute('INSERT INTO e2ee_changes VALUES(?,?,?,?,?,?)', [
    pos,
    localpart,
    '',
    0,
    0,
    canonicalJson(payload),
  ]);
}

export async function clearSigningKeys(
  conn: Conn,
  localpart: string,
  user: string,
  maxEnvelopeBytes: number,
): Promise<void> {
  await conn.execute('DELETE FROM cross_signing_keys WHERE localpart=?', [
    localpart,
  ]);
  await conn.execute(
    'DELETE FROM key_signatures WHERE signer_localpart=? OR target_user=?',
    [localpart, user],
  );
  await appendSigningChange(conn, localpart, user, true, maxEnvelopeBytes);
}
