// Portable verified overlays retain exact target material and signer identity.
// Immutable source intent is separate from a node's mutable overlay index.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';
import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import {
  bounded,
  type Json,
  limitEntries,
  object,
} from '#engine/tenant/e2ee.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import {
  keyMaterial,
  type SignatureSigner,
} from '#engine/tenant/signature-view.ts';

export const SIGNATURE_OPERATIONS_SQL = `
CREATE TABLE signature_operations(operation_id TEXT PRIMARY KEY NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,sequence INTEGER NOT NULL,localpart TEXT NOT NULL,target_user TEXT NOT NULL,target_key TEXT NOT NULL,target_material TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(source,incarnation,sequence));
CREATE INDEX signature_operations_target ON signature_operations(target_user,target_key,target_material);
`;

export type SignatureOperation = {
  version: 1;
  operationId: string;
  source: string;
  incarnation: string;
  sequence: number;
  localpart: string;
  target: { user: string; id: string; json: Json; material: string };
  signers: { signer: SignatureSigner; signature: string }[];
  payloadHash: string;
};

function collision(): never {
  throw new MatrixError(409, 'M_UNKNOWN', 'signature operation collision');
}
function hash(
  body: Omit<SignatureOperation, 'payloadHash'>,
): SignatureOperation {
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}
async function retain(conn: Conn, operation: SignatureOperation) {
  await conn.execute(
    'INSERT INTO signature_operations VALUES(?,?,?,?,?,?,?,?,?)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.sequence,
      operation.localpart,
      operation.target.user,
      operation.target.id,
      operation.target.material,
      canonicalJson(operation),
    ],
  );
}

/** The signature owner calls this only after ordinary wire/authorization and
 * cryptographic checks, in the same transaction as the accepted overlay. */
export async function appendSignatureOperation(
  conn: Conn,
  localpart: string,
  target: SignatureOperation['target'],
  signers: SignatureOperation['signers'],
): Promise<SignatureOperation | undefined> {
  const identity = await tenantAuthority(conn);
  if (!identity) return;
  const sequence = await nextCounter(conn, 'signature_operation');
  const operation = hash({
    version: 1,
    operationId: canonicalJson([
      identity.node,
      identity.incarnation,
      'signature',
      sequence,
    ]),
    source: identity.node,
    incarnation: identity.incarnation,
    sequence,
    localpart,
    target: { ...target, json: JSON.parse(keyMaterial(target.json)) },
    signers: [...signers].sort((a, b) =>
      a.signer.key < b.signer.key ? -1 : a.signer.key > b.signer.key ? 1 : 0
    ),
  });
  await retain(conn, operation);
  return operation;
}

export async function captureSignatureOperations(
  conn: Conn,
  localpart: string,
): Promise<SignatureOperation[]> {
  const identity = await tenantAuthority(conn);
  if (!identity) return [];
  return (await conn.query(
    'SELECT payload_json FROM signature_operations WHERE localpart=? AND source=? AND incarnation=? ORDER BY sequence',
    [localpart, identity.node, identity.incarnation],
  ))
    .map((row) => JSON.parse(String(row.payload_json)) as SignatureOperation);
}

/** Stale or not-yet-known dependencies are retained as original verified facts.
 * The read projection checks current exact target/signer bases, so neither
 * arrival order nor a later stale operation can overwrite a valid overlay. */
export async function importSignatureOperation(
  conn: Conn,
  raw: unknown,
  expected: { source: string; incarnation: string; localpart: string },
): Promise<void> {
  const identity = await tenantAuthority(conn);
  if (!identity) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'signature operation awaits authority',
    );
  }
  const row = object(raw, 'signature operation');
  if (
    row.version !== 1 || row.source !== expected.source ||
    row.incarnation !== expected.incarnation ||
    row.localpart !== expected.localpart ||
    row.source === identity.node || !Number.isSafeInteger(row.sequence) ||
    Number(row.sequence) < 1 ||
    !((row.source === 'home' && row.incarnation === identity.homeIncarnation) ||
      (row.source === identity.edgeNode &&
        row.incarnation === identity.edgeIncarnation)) ||
    !Array.isArray(row.signers) || !row.signers.length
  ) collision();
  const target = object(row.target, 'signature target');
  if (
    typeof target.user !== 'string' || !/^@[^:]+:.+$/.test(target.user) ||
    typeof target.id !== 'string' || !target.id ||
    typeof target.material !== 'string' || !target.material
  ) collision();
  const json = object(target.json, 'signature target material');
  if (canonicalJson(json) !== keyMaterial(json)) collision();
  bounded(json, config().e2ee.maxkeybytes);
  limitEntries(row.signers.length, config().e2ee.maxkeys);
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  const user = '@' + expected.localpart + ':' + tenant.server_name;
  const signers: SignatureOperation['signers'] = [];
  for (const rawSigner of row.signers) {
    const item = object(rawSigner, 'signature signer'),
      signer = object(item.signer, 'signature signer identity');
    if (
      typeof signer.key !== 'string' || !signer.key.startsWith('ed25519:') ||
      typeof signer.public !== 'string' || typeof signer.basis !== 'string' ||
      !signer.basis ||
      !['device', 'master', 'self_signing', 'user_signing'].includes(
        String(signer.usage),
      ) || typeof item.signature !== 'string' || signers.some((held) =>
        held.signer.key === signer.key
      )
    ) collision();
    let valid = false;
    try {
      matrixBase64(item.signature, 64);
      valid = await verifyJson(
        { ...json, signatures: { [user]: { [signer.key]: item.signature } } },
        user,
        signer.key,
        await importPublicKeyFromRaw(matrixBase64(signer.public, 32)),
      );
    } catch { /* Malformed or unverified signatures never become facts. */ }
    if (!valid) collision();
    signers.push({
      signer: {
        key: signer.key,
        public: signer.public,
        basis: signer.basis,
        usage: String(signer.usage),
      },
      signature: item.signature,
    });
  }
  signers.sort((a, b) =>
    a.signer.key < b.signer.key ? -1 : a.signer.key > b.signer.key ? 1 : 0
  );
  const operation = hash({
    version: 1,
    operationId: canonicalJson([
      expected.source,
      expected.incarnation,
      'signature',
      row.sequence,
    ]),
    ...expected,
    sequence: Number(row.sequence),
    target: {
      user: target.user,
      id: target.id,
      json,
      material: target.material,
    },
    signers,
  });
  if (canonicalJson(operation) !== canonicalJson(raw)) collision();
  const [old] = await conn.query(
    'SELECT payload_json FROM signature_operations WHERE operation_id=?',
    [operation.operationId],
  );
  if (old) {
    if (old.payload_json !== canonicalJson(operation)) collision();
    return;
  }
  await retain(conn, operation);
}

export async function signatureOperationOverlays(
  conn: Conn,
  user: string,
  id: string,
  material: string,
): Promise<SignatureOperation[]> {
  return (await conn.query(
    'SELECT payload_json FROM signature_operations WHERE target_user=? AND target_key=? AND target_material=? ORDER BY source,incarnation,sequence',
    [user, id, material],
  ))
    .map((row) => JSON.parse(String(row.payload_json)) as SignatureOperation);
}
