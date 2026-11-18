// OpenID credentials are tenant-owned and purpose-separated from client access
// and refresh tokens. Only hashes reach storage; expiry/deactivation are checked
// in the same transaction as the credential lookup.
import { MatrixError } from '#engine/matrix-error.ts';
import { config } from '#engine/config.ts';
import type { Conn } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { Buffer } from 'node:buffer';
import {
  importRegisterOperation,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import { requireTenantDomainSource } from './domain-source.ts';
import { tenantAuthority } from './session-authority.ts';

function semanticKey(localpart: string, hash: string) {
  return JSON.stringify(['openid', localpart, hash]);
}

function issuerOf(token: string): [string, string] | null {
  const match = /^o\.([A-Za-z0-9_-]+)\.[a-f0-9]{64}$/.exec(token);
  if (!match) return null;
  try {
    const value = JSON.parse(
      Buffer.from(match[1], 'base64url').toString('utf8'),
    );
    if (
      Array.isArray(value) && value.length === 2 &&
      value.every((part) => typeof part === 'string' && part) &&
      Buffer.from(JSON.stringify(value)).toString('base64url') === match[1]
    ) return value as [string, string];
  } catch { /* The routing hint grants no bearer authority. */ }
  return null;
}

async function credential(conn: Conn, hash: string) {
  const [row] = await conn.query(
    'SELECT localpart,expires_ms FROM openid_tokens WHERE token_hash=?',
    [hash],
  );
  return row;
}

export async function openIdOperations(conn: Conn, localpart: string) {
  const keys = await conn.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='openid' AND json_extract(semantic_key,'$[1]')=? ORDER BY semantic_key",
    [localpart],
  );
  const result: RegisterOperation[] = [];
  for (const row of keys) {
    result.push(...await registerOperations(conn, String(row.semantic_key)));
  }
  return result;
}

export async function captureOpenIdOperations(conn: Conn, localpart: string) {
  const authority = await tenantAuthority(conn);
  if (authority?.node !== 'home') {
    throw new Error('OpenID bootstrap requires home authority');
  }
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user || user.deactivated === 1) return [];
  for (
    const row of await conn.query(
      'SELECT token_hash,expires_ms FROM openid_tokens WHERE localpart=? ORDER BY token_hash',
      [localpart],
    )
  ) {
    const hash = String(row.token_hash), key = semanticKey(localpart, hash);
    if ((await registerOperations(conn, key)).length) continue;
    await writeRegister(
      conn,
      { source: authority.node, incarnation: authority.incarnation },
      key,
      'openid',
      JSON.stringify({ hash, expires: Number(row.expires_ms) }),
    );
  }
  return await openIdOperations(conn, localpart);
}

export async function importOpenId(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
) {
  let key: unknown, body: unknown;
  try {
    key = JSON.parse(operation.semanticKey);
    body = JSON.parse(operation.payload);
  } catch {
    throw new Error('invalid OpenID operation');
  }
  if (
    !Array.isArray(key) || key.length !== 3 || key[0] !== 'openid' ||
    typeof key[1] !== 'string' || !key[1] || typeof key[2] !== 'string' ||
    !/^[a-f0-9]{64}$/.test(key[2]) ||
    operation.semanticKey !== semanticKey(key[1], key[2]) ||
    operation.kind !== 'openid' || operation.sequence !== 1 ||
    !Array.isArray(operation.context) ||
    operation.context.length !== 0 || body === null ||
    typeof body !== 'object' || Array.isArray(body)
  ) {
    throw new Error('invalid OpenID operation');
  }
  const localpart = key[1],
    hash = key[2],
    payload = body as Record<string, unknown>;
  if (
    Object.keys(payload).sort().join(',') !== 'expires,hash' ||
    payload.hash !== hash ||
    !Number.isSafeInteger(payload.expires) || Number(payload.expires) < 0
  ) throw new Error('invalid OpenID credential');
  await requireTenantDomainSource(conn, operation, localpart, history);
  const retained = await registerOperations(conn, operation.semanticKey);
  if (
    retained.some((old) =>
      old.operationId !== operation.operationId ||
      old.payloadHash !== operation.payloadHash
    )
  ) {
    throw new Error('immutable OpenID credential differs');
  }
  const before = await credential(conn, hash);
  if (
    before &&
    (before.localpart !== localpart ||
      Number(before.expires_ms) !== payload.expires)
  ) {
    throw new Error('immutable OpenID credential differs');
  }
  await importRegisterOperation(conn, operation);
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user) throw new Error('OpenID account unavailable');
  if (user.deactivated === 1 || before) return;
  await insertOpenId(conn, hash, localpart, Number(payload.expires));
}

export async function createOpenIdToken(
  conn: Conn,
  localpart: string,
  now: number,
  expires: number,
) {
  const authority = await tenantAuthority(conn);
  const secret = crypto.randomUUID().replaceAll('-', '') +
    crypto.randomUUID().replaceAll('-', '');
  const token = authority
    ? 'o.' +
      Buffer.from(JSON.stringify([authority.node, authority.incarnation]))
        .toString('base64url') +
      '.' + secret
    : secret;
  const hash = await hashToken(token);
  if (authority) {
    await writeRegister(
      conn,
      { source: authority.node, incarnation: authority.incarnation },
      semanticKey(localpart, hash),
      'openid',
      JSON.stringify({ hash, expires }),
    );
  }
  await expireOpenId(conn, now);
  await insertOpenId(conn, hash, localpart, expires);
  return token;
}

export async function readOpenIdUser(
  conn: Conn,
  token: string,
  hash: string,
  now: number,
) {
  const localpart = await openIdUser(conn, hash, now);
  if (localpart !== null || await credential(conn, hash)) return localpart;
  // Retained immutable facts also prove an expired/pruned credential known.
  const [known] = await conn.query(
    "SELECT 1 FROM domain_operations WHERE kind='openid' AND json_extract(semantic_key,'$[2]')=? LIMIT 1",
    [hash],
  );
  const authority = await tenantAuthority(conn), issuer = issuerOf(token);
  if (
    !known && authority && issuer &&
    (issuer[0] === 'home' || issuer[0] === authority.edgeNode) &&
    (issuer[0] !== authority.node || issuer[1] !== authority.incarnation)
  ) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'OpenID replica unavailable');
  }
  return null;
}

export async function insertOpenId(
  conn: Conn,
  hash: string,
  localpart: string,
  expires: number,
): Promise<void> {
  await conn.execute(
    'INSERT INTO openid_tokens(token_hash,localpart,expires_ms) VALUES(?,?,?)',
    [hash, localpart, expires],
  );
}
export async function openIdUser(
  conn: Conn,
  hash: string,
  now: number,
): Promise<string | null> {
  const rows = await conn.query(
    'SELECT o.localpart FROM openid_tokens o JOIN users u ON u.localpart=o.localpart WHERE o.token_hash=? AND o.expires_ms>? AND u.deactivated=0',
    [hash, now],
  );
  return rows.length ? String(rows[0].localpart) : null;
}
export async function clearOpenId(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM openid_tokens WHERE localpart=?', [
    localpart,
  ]);
}
export async function expireOpenId(conn: Conn, now: number): Promise<void> {
  await conn.execute('DELETE FROM openid_tokens WHERE expires_ms<=?', [now]);
}

export async function issueOpenIdToken(
  tenant: Tenant,
  localpart: string,
  now = Date.now(),
) {
  const lifetime = config().openid.tokenseconds;
  const expires = now + lifetime * 1000;
  if (!Number.isSafeInteger(expires)) {
    throw new Error('OpenID expiry exceeds integer range');
  }
  const token = await tenant.tx(async (tx) => {
    await tx.ingress.check({ kind: 'domain', localpart, feature: 'openid' });
    const user = await tx.users.byLocalpart(localpart);
    if (user === null || user.deactivated) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'active account required');
    }
    return await tx.openid.issue(localpart, now, expires);
  });
  return {
    access_token: token,
    token_type: 'Bearer',
    matrix_server_name: tenant.serverName,
    expires_in: lifetime,
  };
}

export async function openIdUserInfo(
  tenant: Tenant,
  token: string,
  now = Date.now(),
): Promise<{ sub: string }> {
  if (!token) {
    throw new MatrixError(401, 'M_MISSING_TOKEN', 'OpenID token required');
  }
  const hash = await hashToken(token);
  const localpart = await tenant.tx(async (tx) => {
    await tx.ingress.check({ kind: 'openid', hash });
    return await tx.openid.read(token, hash, now);
  });
  if (localpart === null) {
    throw new MatrixError(
      401,
      'M_UNKNOWN_TOKEN',
      'OpenID token unknown or expired',
    );
  }
  return { sub: '@' + localpart + ':' + tenant.serverName };
}
