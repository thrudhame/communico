// Home owns complete cross-signing identity revisions. The selected-account
// link carries public keys, including own-user user-signing material, not any
// private signing key. Imported revisions never become local source intent.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import {
  signingKey,
  type SigningUsage,
  signingUsages,
  verifySigningKey,
} from '#engine/e2ee-signing.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import {
  appendSigningChange,
  signingState,
} from '#engine/tenant/cross-signing.ts';
import { type Json, object } from '#engine/tenant/e2ee.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import { forgetKeySignatures } from '#engine/tenant/signature-view.ts';

export const SIGNING_OPERATIONS_SQL = `
CREATE TABLE signing_operations(operation_id TEXT PRIMARY KEY NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,sequence INTEGER NOT NULL,localpart TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(source,incarnation,sequence));
CREATE INDEX signing_operations_account ON signing_operations(localpart,source,incarnation,sequence);
`;

export type SigningOperation = {
  version: 1;
  operationId: string;
  source: 'home';
  incarnation: string;
  sequence: number;
  localpart: string;
  keys: { usage: SigningUsage; key: Json; revision: number }[];
  payloadHash: string;
};

function collision(): never {
  throw new MatrixError(409, 'M_UNKNOWN', 'signing operation collision');
}
function hash(body: Omit<SigningOperation, 'payloadHash'>): SigningOperation {
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}
async function retain(conn: Conn, operation: SigningOperation) {
  await conn.execute('INSERT INTO signing_operations VALUES(?,?,?,?,?,?)', [
    operation.operationId,
    operation.source,
    operation.incarnation,
    operation.sequence,
    operation.localpart,
    canonicalJson(operation),
  ]);
}

/** Called in the identity mutation transaction, and for pre-enrollment
 * bootstrap. A repeated capture never allocates another identity revision. */
export async function captureSigningOperations(
  conn: Conn,
  localpart: string,
): Promise<SigningOperation[]> {
  const authority = await tenantAuthority(conn);
  if (!authority || authority.node !== 'home') return [];
  const operations = (await conn.query(
    "SELECT payload_json FROM signing_operations WHERE localpart=? AND source='home' AND incarnation=? ORDER BY sequence",
    [localpart, authority.incarnation],
  )).map((row) => JSON.parse(String(row.payload_json)) as SigningOperation);
  const keys = (await conn.query(
    'SELECT usage,key_json,revision FROM cross_signing_keys WHERE localpart=? ORDER BY usage',
    [localpart],
  )).map((row) => ({
    usage: row.usage as SigningUsage,
    key: JSON.parse(String(row.key_json)) as Json,
    revision: Number(row.revision),
  }));
  if (canonicalJson(operations.at(-1)?.keys) === canonicalJson(keys)) {
    return operations;
  }
  const sequence = await nextCounter(conn, 'signing_operation');
  const operation = hash({
    version: 1,
    operationId: canonicalJson([
      'home',
      authority.incarnation,
      'signing',
      sequence,
    ]),
    source: 'home',
    incarnation: authority.incarnation,
    sequence,
    localpart,
    keys,
  });
  await retain(conn, operation);
  return [...operations, operation];
}

async function operationOf(
  raw: unknown,
  user: string,
): Promise<SigningOperation> {
  const row = object(raw, 'signing operation');
  if (
    row.version !== 1 || row.source !== 'home' ||
    typeof row.incarnation !== 'string' || !row.incarnation ||
    typeof row.localpart !== 'string' || !row.localpart ||
    !Number.isSafeInteger(row.sequence) || Number(row.sequence) < 1 ||
    !Array.isArray(row.keys)
  ) collision();
  const keys: SigningOperation['keys'] = [];
  for (const rawKey of row.keys) {
    const item = object(rawKey, 'signing operation key');
    const usage = signingUsages.find((usage) => usage === item.usage);
    if (
      !usage || !Number.isSafeInteger(item.revision) ||
      Number(item.revision) < 1 || keys.some((key) => key.usage === usage)
    ) collision();
    const parsed = signingKey(item.key, user, usage, config().e2ee);
    keys.push({
      usage,
      key: JSON.parse(parsed.json),
      revision: Number(item.revision),
    });
  }
  keys.sort((a, b) =>
    signingUsages.indexOf(a.usage) - signingUsages.indexOf(b.usage)
  );
  const master = keys.find((key) => key.usage === 'master');
  if (keys.length && !master) collision();
  if (master) {
    const signer = signingKey(master.key, user, 'master', config().e2ee);
    for (const item of keys) {
      if (
        item.usage !== 'master' &&
        !await verifySigningKey(item.key, user, signer)
      ) {
        collision();
      }
    }
  }
  const operation = hash({
    version: 1,
    operationId: canonicalJson([
      'home',
      row.incarnation,
      'signing',
      row.sequence,
    ]),
    source: 'home',
    incarnation: row.incarnation,
    sequence: Number(row.sequence),
    localpart: row.localpart,
    keys,
  });
  if (canonicalJson(operation) !== canonicalJson(raw)) collision();
  return operation;
}

/** The authenticated link supplies expected account/source identity. This
 * owner rechecks the tenant fence and retains out-of-order facts without ever
 * replacing a newer home revision or undoing local terminal deactivation. */
export async function importSigningOperation(
  conn: Conn,
  raw: unknown,
  expected: { source: string; incarnation: string; localpart: string },
): Promise<void> {
  const authority = await tenantAuthority(conn);
  if (!authority) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'signing operation awaits authority',
    );
  }
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  const user = '@' + expected.localpart + ':' + tenant.server_name;
  const operation = await operationOf(raw, user);
  if (
    expected.source !== 'home' || operation.source !== expected.source ||
    operation.incarnation !== expected.incarnation ||
    operation.incarnation !== authority.homeIncarnation ||
    operation.localpart !== expected.localpart || authority.node === 'home'
  ) collision();
  const [old] = await conn.query(
    'SELECT payload_json FROM signing_operations WHERE operation_id=?',
    [operation.operationId],
  );
  if (old) {
    if (old.payload_json !== canonicalJson(operation)) collision();
    return;
  }
  const [newer] = await conn.query(
    "SELECT 1 FROM signing_operations WHERE localpart=? AND source='home' AND incarnation=? AND sequence>? LIMIT 1",
    [operation.localpart, operation.incarnation, operation.sequence],
  );
  const [account] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [operation.localpart],
  );
  if (!account) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'signing operation awaits account',
    );
  }
  await retain(conn, operation);
  if (newer || account.deactivated === 1) return;
  const previous = await signingState(conn, operation.localpart);
  for (const usage of signingUsages) {
    const held = previous[usage];
    const next = operation.keys.find((key) => key.usage === usage);
    if (held && held.json !== canonicalJson(next?.key)) {
      await forgetKeySignatures(conn, user, held.public);
    }
  }
  await conn.execute('DELETE FROM cross_signing_keys WHERE localpart=?', [
    operation.localpart,
  ]);
  for (const item of operation.keys) {
    const key = signingKey(item.key, user, item.usage, config().e2ee);
    await conn.execute('INSERT INTO cross_signing_keys VALUES(?,?,?,?,?)', [
      operation.localpart,
      item.usage,
      key.id,
      key.json,
      item.revision,
    ]);
  }
  const next = await signingState(conn, operation.localpart);
  if (canonicalJson(previous) !== canonicalJson(next)) {
    await appendSigningChange(
      conn,
      operation.localpart,
      user,
      ['master', 'self_signing'].some((usage) =>
        previous[usage as SigningUsage]?.json !==
          next[usage as SigningUsage]?.json
      ),
      config().federation.bulkmaxbytes,
    );
  }
}
