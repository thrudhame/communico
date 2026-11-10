// OpenID credentials are tenant-owned and purpose-separated from client access
// and refresh tokens. Only hashes reach storage; expiry/deactivation are checked
// in the same transaction as the credential lookup.
import { MatrixError } from '#engine/matrix-error.ts';
import { config } from '#engine/config.ts';
import type { Conn } from '#engine/store/db.ts';
import { hashToken } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';

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
  const token = crypto.randomUUID().replaceAll('-', '') +
    crypto.randomUUID().replaceAll('-', '');
  const hash = await hashToken(token);
  const lifetime = config().openid.tokenseconds;
  const expires = now + lifetime * 1000;
  if (!Number.isSafeInteger(expires)) {
    throw new Error('OpenID expiry exceeds integer range');
  }
  await tenant.tx(async (tx) => {
    const user = await tx.users.byLocalpart(localpart);
    if (user === null || user.deactivated) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'active account required');
    }
    await tx.openid.expire(now);
    await tx.openid.insert(hash, localpart, expires);
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
  const localpart = await tenant.tx((tx) => tx.openid.user(hash, now));
  if (localpart === null) {
    throw new MatrixError(
      401,
      'M_UNKNOWN_TOKEN',
      'OpenID token unknown or expired',
    );
  }
  return { sub: '@' + localpart + ':' + tenant.serverName };
}
