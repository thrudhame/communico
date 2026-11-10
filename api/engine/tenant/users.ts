// api/engine/tenant/users.ts — hosted users (custodial, argon2id
// credentials, OWASP defaults m=19456 KiB/t=2/p=1 — the PHC string
// encodes algorithm+params+salt in-band), registration, profiles,
// password change and deactivation. The old registerUser also wrote the
// presence row; presence lives in the server file — stage 4b.
import {
  hash as argonHash,
  verify as argonVerify,
} from '@stdext/crypto/hash/argon2';
import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  hashToken,
  REFRESH_LIFETIME_MS,
  revokeDeviceTokens,
} from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { setProfileRow } from '#engine/tenant/profiles.ts';
import type { ErasureCut } from '#engine/room/state.ts';

// Spec appendices: user_id_localpart = 1*user_id_char;
// user_id_char = DIGIT / a-z / "-" / "." / "=" / "_" / "/" / "+".
// Downcased before validation (Complement checks downcasing explicitly).
const LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;

export function checkLocalpart(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new MatrixError(400, 'M_INVALID_USERNAME', 'username required');
  }
  const localpart = raw.toLowerCase();
  if (!LOCALPART_RE.test(localpart) || localpart.length > 255) {
    throw new MatrixError(
      400,
      'M_INVALID_USERNAME',
      'invalid username: ' + raw,
    );
  }
  return localpart;
}

const ARGON_OPTS = {
  algorithm: 'argon2id',
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): string {
  return argonHash(password, { ...ARGON_OPTS });
}

export function verifyPassword(phc: string, password: string): boolean {
  try {
    return argonVerify(password, phc, { ...ARGON_OPTS });
  } catch {
    return false;
  }
}

// --- conn-level rows (bound on TenantTx) -----------------------------------

export async function userExists(
  conn: Conn,
  localpart: string,
): Promise<boolean> {
  const rows = await conn.query(
    'SELECT localpart FROM users WHERE localpart = ?',
    [localpart],
  );
  return rows.length > 0;
}

export async function insertUser(
  conn: Conn,
  localpart: string,
  displayName: string,
): Promise<void> {
  await conn.execute(
    'INSERT INTO users (localpart, display_name) VALUES (?, ?)',
    [localpart, displayName],
  );
}

export type ProfileRow = {
  display_name: string | null;
  avatar_url: string | null;
  deactivated: boolean;
};

export async function userByLocalpart(
  conn: Conn,
  localpart: string,
): Promise<ProfileRow | null> {
  const rows = await conn.query(
    'SELECT display_name, avatar_url, deactivated FROM users WHERE localpart = ?',
    [localpart],
  );
  if (rows.length === 0) return null;
  return {
    display_name: rows[0].display_name == null
      ? null
      : String(rows[0].display_name),
    avatar_url: rows[0].avatar_url == null ? null : String(rows[0].avatar_url),
    deactivated: rows[0].deactivated === 1,
  };
}

export async function setUserDisplayName(
  conn: Conn,
  localpart: string,
  name: string | null,
): Promise<void> {
  await setProfileRow(conn, localpart, 'displayname', name);
}

export async function setUserAvatarUrl(
  conn: Conn,
  localpart: string,
  url: string | null,
): Promise<void> {
  await setProfileRow(conn, localpart, 'avatar_url', url);
}

export async function markDeactivated(
  conn: Conn,
  localpart: string,
): Promise<void> {
  const old = await userByLocalpart(conn, localpart);
  if (old === null || old.deactivated) return;
  await conn.execute(
    'UPDATE users SET deactivated = 1, display_name = NULL, avatar_url = NULL WHERE localpart = ?',
    [localpart],
  );
  await conn.execute(
    "INSERT INTO account_changes(pos,localpart,kind) VALUES(?,?,'deactivated')",
    [await nextCounter(conn, 'account_changes'), localpart],
  );
}

export async function setCredential(
  conn: Conn,
  localpart: string,
  phc: string,
): Promise<void> {
  await conn.execute(
    "INSERT INTO credentials (localpart, kind, hash, salt, params) VALUES (?, 'argon2id', ?, NULL, NULL) ON CONFLICT (localpart) DO UPDATE SET hash = excluded.hash",
    [localpart, phc],
  );
}

export async function credentialHash(
  conn: Conn,
  localpart: string,
): Promise<string | null> {
  const rows = await conn.query(
    "SELECT hash FROM credentials WHERE localpart = ? AND kind = 'argon2id'",
    [localpart],
  );
  return rows.length === 0 ? null : String(rows[0].hash);
}

export async function clearCredential(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM credentials WHERE localpart=?', [localpart]);
}

// --- tenant-level behaviour --------------------------------------------------

/** Registration's pre-UIA availability check (the old endpoints queried
 * users directly). Keep tenant storage access behind the engine. */
export function isRegistered(
  tenant: Tenant,
  localpart: string,
): Promise<boolean> {
  return tenant.tx((tx) => tx.users.exists(localpart));
}

export type RegisterParams = {
  localpart: string;
  password: string;
  deviceId?: string;
  displayName?: string;
  deviceDisplayName?: string;
  // Fixed token override (dev seeds). null = inhibit_login (no token).
  // undefined = mint a random token.
  accessToken?: string | null;
};

export type RegisterResult = {
  user_id: string;
  access_token?: string;
  device_id: string;
  home_server: string;
};

// The real /register path (endpoint + dev seeds share it). Throws
// MatrixError M_USER_IN_USE (400) for taken localparts.
export async function registerUser(
  tenant: Tenant,
  params: RegisterParams,
): Promise<RegisterResult> {
  const localpart = checkLocalpart(params.localpart);
  if (typeof params.password !== 'string' || params.password.length === 0) {
    throw new MatrixError(400, 'M_BAD_REQUEST', 'password required');
  }
  const deviceId = params.deviceId && params.deviceId.length > 0
    ? params.deviceId
    : crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const displayName =
    typeof params.displayName === 'string' && params.displayName.length > 0
      ? params.displayName
      : localpart;
  // null = inhibit_login (no token); a non-empty string is taken verbatim
  // (dev seeds); otherwise mint a random one.
  let accessToken: string | undefined;
  if (params.accessToken !== null) {
    accessToken =
      typeof params.accessToken === 'string' && params.accessToken.length > 0
        ? params.accessToken
        : crypto.randomUUID();
  }
  const accessHash = accessToken === undefined
    ? null
    : await hashToken(accessToken);
  return await tenant.tx(async (tx) => {
    if (await tx.users.exists(localpart)) {
      throw new MatrixError(400, 'M_USER_IN_USE', 'user in use: ' + localpart);
    }
    await tx.users.insert(localpart, displayName);
    await tx.credentials.set(localpart, hashPassword(params.password));
    await tx.devices.upsert(
      deviceId,
      localpart,
      params.deviceDisplayName ?? displayName,
    );
    if (accessHash !== null) {
      await tx.tokens.insert(accessHash, localpart, deviceId, null);
    }
    return {
      user_id: `@${localpart}:${tenant.serverName}`,
      access_token: accessToken,
      device_id: deviceId,
      home_server: tenant.serverName,
    };
  });
}

export async function verifyUserPassword(
  tenant: Tenant,
  localpart: string,
  password: string,
): Promise<boolean> {
  const hash = await tenant.tx((tx) => tx.credentials.hash(localpart));
  if (hash === null) return false;
  return verifyPassword(hash, password);
}

/** Authentication, device ownership and session replacement are one tenant
 * operation. A failure cannot expose a partial device or revoke an old pair. */
export async function loginUser(
  tenant: Tenant,
  params: {
    localpart: string;
    password: string;
    deviceId: string;
    displayName?: string;
    refresh: boolean;
  },
): Promise<
  { accessToken: string; refreshToken?: string; expiresInMs?: number }
> {
  const accessToken = crypto.randomUUID();
  const accessHash = await hashToken(accessToken);
  const refreshToken = params.refresh ? crypto.randomUUID() : undefined;
  const refreshHash = refreshToken === undefined
    ? null
    : await hashToken(refreshToken);
  return await tenant.tx(async (tx) => {
    const phc = await tx.credentials.hash(params.localpart);
    if (phc === null || !verifyPassword(phc, params.password)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'invalid username or password');
    }
    if ((await tx.users.byLocalpart(params.localpart))?.deactivated) {
      throw new MatrixError(403, 'M_USER_DEACTIVATED', 'account deactivated');
    }
    await tx.devices.upsert(
      params.deviceId,
      params.localpart,
      params.displayName ?? null,
    );
    await revokeDeviceTokens(tx, params.deviceId, params.localpart);
    await tx.tokens.insert(
      accessHash,
      params.localpart,
      params.deviceId,
      params.refresh ? Date.now() + REFRESH_LIFETIME_MS : null,
    );
    if (refreshHash !== null) {
      await tx.refresh.insert(
        refreshHash,
        params.localpart,
        params.deviceId,
        accessHash,
      );
    }
    return {
      accessToken,
      refreshToken,
      expiresInMs: params.refresh ? REFRESH_LIFETIME_MS : undefined,
    };
  });
}

/** The user's profile fields; null = no such user. Keys omitted when unset. */
export async function getProfile(
  tenant: Tenant,
  localpart: string,
): Promise<{ displayname?: string; avatar_url?: string } | null> {
  return await tenant.tx(async (tx) => {
    const row = await tx.users.byLocalpart(localpart);
    if (row === null) return null;
    const out: { displayname?: string; avatar_url?: string } = {};
    if (row.display_name !== null) out.displayname = row.display_name;
    if (row.avatar_url !== null) out.avatar_url = row.avatar_url;
    return out;
  });
}

// Band C (D5): the setters return the old/new values so callers (the
// profile fan-out) can see the change.
export async function setDisplayName(
  tenant: Tenant,
  localpart: string,
  name: string | null,
): Promise<{ oldValue: string | null; newValue: string | null }> {
  return await tenant.tx(async (tx) => {
    const row = await tx.users.byLocalpart(localpart);
    const oldValue = row === null ? null : row.display_name;
    await tx.profiles.set(localpart, 'displayname', name);
    return { oldValue, newValue: name };
  });
}

export async function setAvatarUrl(
  tenant: Tenant,
  localpart: string,
  url: string | null,
): Promise<{ oldValue: string | null; newValue: string | null }> {
  return await tenant.tx(async (tx) => {
    const row = await tx.users.byLocalpart(localpart);
    const oldValue = row === null ? null : row.avatar_url;
    await tx.profiles.set(
      localpart,
      'avatar_url',
      url === null ? undefined : url,
    );
    return { oldValue, newValue: url };
  });
}

/** Change the password; optionally log out every other device (their
 * tokens and pushers go with them). keepToken (the caller's) survives. */
export async function changePassword(
  tenant: Tenant,
  localpart: string,
  newPassword: string,
  opts: { keepToken?: string; logoutDevices: boolean },
): Promise<void> {
  const keepHash = opts.keepToken === undefined
    ? null
    : await hashToken(opts.keepToken);
  await tenant.tx(async (tx) => {
    await tx.credentials.set(localpart, hashPassword(newPassword));
    if (!opts.logoutDevices) return;
    let keepDevice: string | null = null;
    if (keepHash !== null) {
      const keep = await tx.tokens.byHash(keepHash);
      if (keep !== null && keep.localpart === localpart) {
        keepDevice = keep.device_id;
      }
    }
    for (const token of await tx.tokens.ofUser(localpart)) {
      if (keepHash !== null && token.token === keepHash) continue;
      await tx.pushers.deleteForToken(token.token);
      await tx.refresh.deleteForAccessToken(token.token);
      await tx.tokens.delete(token.token);
    }
    for (const device of await tx.devices.ofUser(localpart)) {
      if (keepDevice !== null && device.device_id === keepDevice) continue;
      await tx.devices.delete(device.device_id, localpart);
    }
  });
}

/** Deactivate: pushers, tokens and devices all go; the user row is marked
 * deactivated and its profile fields cleared. Later login → 403. */
export async function deactivateUser(
  tenant: Tenant,
  localpart: string,
  erasureCuts?: Record<string, ErasureCut>,
): Promise<void> {
  await tenant.tx(async (tx) => {
    if (erasureCuts !== undefined) {
      await tx.erasure.mark(localpart, erasureCuts);
    }
    await tx.pushers.deleteForUser(localpart);
    await tx.openid.clear(localpart);
    await tx.refresh.deleteForUser(localpart);
    await tx.tokens.deleteForUser(localpart);
    await tx.devices.deleteForUser(localpart);
    await tx.crossSigning.clear(
      localpart,
      '@' + localpart + ':' + tenant.serverName,
    );
    await tx.keyBackup.clear(localpart);
    await tx.profiles.clear(localpart);
    if (erasureCuts !== undefined) {
      await tx.accountData.clear(localpart);
      await tx.filters.clear(localpart);
      await tx.pushRules.clear(localpart);
      await tx.credentials.clear(localpart);
    }
    await tx.users.markDeactivated(localpart);
  });
}

export async function isDeactivated(
  tenant: Tenant,
  localpart: string,
): Promise<boolean> {
  return await tenant.tx(async (tx) => {
    const row = await tx.users.byLocalpart(localpart);
    return row !== null && row.deactivated;
  });
}
