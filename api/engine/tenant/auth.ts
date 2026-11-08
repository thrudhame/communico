// api/engine/tenant/auth.ts — access and refresh tokens. The old code
// stored tokens plain (doltgres:api/engine/tenant.ts); this module stores
// only the hex sha-256 of each token (plan §3) — the plain token leaves
// the server only at issue time. Rotation revokes the old access token,
// but retains its refresh token until the replacement pair is used. Unknown
// refresh token → 401 M_UNKNOWN_TOKEN (refresh.yaml:89-101).
import type { Conn } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Tenant, TenantTx } from '#engine/tenant/index.ts';
import { deviceById } from '#engine/tenant/devices.ts';

// The informational access-token lifetime advertised at refresh (band C
// D8: expires_in_ms is advertised, never enforced — spec: optional).
export const REFRESH_LIFETIME_MS = 3_600_000;

export { localpartOf } from '#engine/ids.ts';

/** The stored form of a token: lowercase hex sha-256. */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(token),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export type TokenInfo = {
  localpart: string;
  user_id: string;
  device_id: string | null;
  generation: number | null;
  // band C (D8): informational expiry (nullable; never enforced)
  expires_ms: number | null;
};

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function insertAccessToken(
  conn: Conn,
  hash: string,
  localpart: string,
  deviceId: string | null,
  expiresMs: number | null,
): Promise<void> {
  const device = deviceId === null
    ? null
    : await deviceById(conn, deviceId, localpart);
  if (deviceId !== null && device === null) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'device no longer exists');
  }
  await conn.execute(
    'INSERT INTO access_tokens (token, localpart, device_id, generation, expires_ms) VALUES (?, ?, ?, ?, ?) ON CONFLICT (token) DO NOTHING',
    [hash, localpart, deviceId, device?.generation ?? null, expiresMs],
  );
}

export type AccessTokenRow = {
  token: string;
  localpart: string;
  device_id: string | null;
  generation: number | null;
  expires_ms: number | null;
};

function accessRow(row: Record<string, unknown>): AccessTokenRow {
  return {
    token: String(row.token),
    localpart: String(row.localpart),
    device_id: row.device_id == null ? null : String(row.device_id),
    generation: row.generation == null ? null : Number(row.generation),
    expires_ms: row.expires_ms == null ? null : Number(row.expires_ms),
  };
}

export async function accessTokenByHash(
  conn: Conn,
  hash: string,
): Promise<AccessTokenRow | null> {
  const rows = await conn.query(
    'SELECT token, localpart, device_id, generation, expires_ms FROM access_tokens WHERE token = ?',
    [hash],
  );
  return rows.length === 0 ? null : accessRow(rows[0]);
}

export async function accessTokensOfUser(
  conn: Conn,
  localpart: string,
): Promise<AccessTokenRow[]> {
  const rows = await conn.query(
    'SELECT token, localpart, device_id, generation, expires_ms FROM access_tokens WHERE localpart = ?',
    [localpart],
  );
  return rows.map(accessRow);
}

export async function accessTokensOfDevice(
  conn: Conn,
  deviceId: string,
  localpart: string,
): Promise<AccessTokenRow[]> {
  const rows = await conn.query(
    'SELECT token, localpart, device_id, generation, expires_ms FROM access_tokens WHERE device_id = ? AND localpart = ?',
    [deviceId, localpart],
  );
  return rows.map(accessRow);
}

export async function deleteAccessToken(
  conn: Conn,
  hash: string,
): Promise<void> {
  await conn.execute('DELETE FROM access_tokens WHERE token = ?', [hash]);
}

export async function deleteAccessTokensOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM access_tokens WHERE localpart = ?', [
    localpart,
  ]);
}

export async function insertRefreshToken(
  conn: Conn,
  hash: string,
  localpart: string,
  deviceId: string | null,
  accessHash: string,
): Promise<void> {
  const access = await accessTokenByHash(conn, accessHash);
  if (
    access === null || access.localpart !== localpart ||
    access.device_id !== deviceId
  ) throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'invalid refresh device');
  await conn.execute(
    'INSERT INTO refresh_tokens (token, localpart, device_id, generation, access_token) VALUES (?, ?, ?, ?, ?)',
    [hash, localpart, deviceId, access.generation, accessHash],
  );
}

export type RefreshTokenRow = {
  localpart: string;
  device_id: string | null;
  generation: number | null;
  access_token: string;
  next_token: string | null;
};

export async function refreshTokenByHash(
  conn: Conn,
  hash: string,
): Promise<RefreshTokenRow | null> {
  const rows = await conn.query(
    'SELECT localpart, device_id, generation, access_token, next_token FROM refresh_tokens WHERE token = ?',
    [hash],
  );
  if (rows.length === 0) return null;
  return {
    localpart: String(rows[0].localpart),
    device_id: rows[0].device_id == null ? null : String(rows[0].device_id),
    generation: rows[0].generation == null ? null : Number(rows[0].generation),
    access_token: String(rows[0].access_token),
    next_token: rows[0].next_token == null ? null : String(rows[0].next_token),
  };
}

export async function deleteRefreshToken(
  conn: Conn,
  hash: string,
): Promise<void> {
  await conn.execute('DELETE FROM refresh_tokens WHERE token = ?', [hash]);
}

export async function deleteRefreshForAccessToken(
  conn: Conn,
  accessHash: string,
): Promise<void> {
  await conn.execute('DELETE FROM refresh_tokens WHERE access_token = ?', [
    accessHash,
  ]);
}

export async function deleteRefreshTokensOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM refresh_tokens WHERE localpart = ?', [
    localpart,
  ]);
}

/** First use closes the predecessor's retry window in the same transaction. */
export async function confirmRefreshToken(
  conn: Conn,
  hash: string,
): Promise<void> {
  await conn.execute('DELETE FROM refresh_tokens WHERE next_token = ?', [hash]);
}

export async function confirmAccessToken(
  conn: Conn,
  hash: string,
): Promise<void> {
  await conn.execute(
    'DELETE FROM refresh_tokens WHERE access_token = ? AND next_token IS NOT NULL',
    [hash],
  );
}

/** A pending predecessor references the candidate access token, so every
 * device/user/token revocation also removes its retry window. */
export async function replaceRefreshToken(
  conn: Conn,
  hash: string,
  nextHash: string,
  accessHash: string,
): Promise<void> {
  await conn.execute(
    'UPDATE refresh_tokens SET next_token = ?, access_token = ? WHERE token = ?',
    [nextHash, accessHash, hash],
  );
}

// --- tenant-level behaviour --------------------------------------------------

/** Mint an access token; only its hash is stored. */
export async function issueToken(
  tenant: Tenant,
  localpart: string,
  deviceId: string,
  expiresMs?: number,
): Promise<string> {
  const token = crypto.randomUUID();
  const hash = await hashToken(token);
  await tenant.tx(async (tx) => {
    await tx.devices.upsert(deviceId, localpart, null);
    await tx.tokens.insert(hash, localpart, deviceId, expiresMs ?? null);
  });
  return token;
}

/** The token's owner, or null when unknown. */
export async function lookupToken(
  tenant: Tenant,
  token: string,
): Promise<TokenInfo | null> {
  const hash = await hashToken(token);
  return await tenant.tx(async (tx) => {
    const row = await tx.tokens.byHash(hash);
    if (row === null) return null;
    if (row.device_id !== null) {
      const device = await tx.devices.byId(row.device_id, row.localpart);
      if (device === null || device.generation !== row.generation) return null;
    }
    await tx.refresh.confirmAccess(hash);
    return {
      localpart: row.localpart,
      user_id: `@${row.localpart}:${tenant.serverName}`,
      device_id: row.device_id,
      generation: row.generation,
      expires_ms: row.expires_ms,
    };
  });
}

/** Mint a refresh token paired with an existing access token. */
export async function issueRefreshToken(
  tenant: Tenant,
  localpart: string,
  deviceId: string,
  accessToken: string,
): Promise<string> {
  const token = crypto.randomUUID();
  const hash = await hashToken(token);
  const accessHash = await hashToken(accessToken);
  await tenant.tx((tx) =>
    tx.refresh.insert(hash, localpart, deviceId, accessHash)
  );
  return token;
}

// MSC2918: retries can replace an unused candidate, never an accepted one.
// All rotation/use decisions are serialized by the tenant transaction, and
// survive restarts without storing plaintext tokens or an in-memory grace timer.
export async function consumeRefreshToken(
  tenant: Tenant,
  refreshToken: string,
): Promise<
  { accessToken: string; refreshToken: string; expiresInMs: number }
> {
  const hash = await hashToken(refreshToken);
  return await tenant.tx(async (tx) => {
    const row = await tx.refresh.byHash(hash);
    if (row === null) {
      throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'unknown refresh token');
    }
    if (row.device_id !== null) {
      const device = await tx.devices.byId(row.device_id, row.localpart);
      if (device === null || device.generation !== row.generation) {
        throw new MatrixError(
          401,
          'M_UNKNOWN_TOKEN',
          'device no longer exists',
        );
      }
    }
    await tx.refresh.confirm(hash);
    if (row.next_token !== null) await tx.refresh.delete(row.next_token);
    const accessToken = crypto.randomUUID();
    const accessHash = await hashToken(accessToken);
    await tx.tokens.insert(
      accessHash,
      row.localpart,
      row.device_id,
      Date.now() + REFRESH_LIFETIME_MS,
    );
    const newRefresh = crypto.randomUUID();
    const refreshHash = await hashToken(newRefresh);
    await tx.refresh.insert(
      refreshHash,
      row.localpart,
      row.device_id,
      accessHash,
    );
    await tx.refresh.replace(hash, refreshHash, accessHash);
    await tx.pushers.moveToken(row.access_token, accessHash);
    await tx.tokens.delete(row.access_token);
    return {
      accessToken,
      refreshToken: newRefresh,
      expiresInMs: REFRESH_LIFETIME_MS,
    };
  });
}

/** Log one token out: its pushers die with it, and logging out removes
 * the device too (Synapse semantics — the logout gate asserts the device
 * list shrinks). Refresh tokens riding the revoked access tokens go as
 * well (child rows first; the old code left them behind). */
export async function revokeToken(tenant: Tenant, token: string) {
  const hash = await hashToken(token);
  await tenant.tx(async (tx) => {
    const row = await tx.tokens.byHash(hash);
    const deviceId = row === null ? null : row.device_id;
    await tx.pushers.deleteForToken(hash);
    await tx.refresh.deleteForAccessToken(hash);
    await tx.tokens.delete(hash);
    if (deviceId !== null && row !== null) {
      await tx.devices.delete(deviceId, row.localpart);
    }
  });
}

/** Revoke a device's sessions without deleting its owned device row. */
export async function revokeDeviceTokens(
  tx: TenantTx,
  deviceId: string,
  localpart: string,
): Promise<void> {
  for (const token of await tx.tokens.ofDevice(deviceId, localpart)) {
    await tx.pushers.deleteForToken(token.token);
    await tx.refresh.deleteForAccessToken(token.token);
    await tx.tokens.delete(token.token);
  }
}

/** Every token, pusher and device of the user goes (child rows first). */
export async function revokeAllTokens(
  tenant: Tenant,
  localpart: string,
): Promise<void> {
  await tenant.tx(async (tx) => {
    await tx.pushers.deleteForUser(localpart);
    await tx.refresh.deleteForUser(localpart);
    await tx.tokens.deleteForUser(localpart);
    await tx.devices.deleteForUser(localpart);
  });
}
