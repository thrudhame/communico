// Public profile storage and atomic whole-profile validation. Membership keeps
// using users.getProfile: custom fields must never enter member event content.
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export type Profile = Record<string, unknown> & {
  displayname?: string;
  avatar_url?: string;
};
const KEY =
  /^(avatar_url|displayname|m\.tz|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+)$/;
const encoder = new TextEncoder();

export function checkProfileKey(key: string): void {
  if (encoder.encode(key).length > 255) {
    throw new MatrixError(
      400,
      'M_KEY_TOO_LARGE',
      'profile key exceeds 255 bytes',
    );
  }
  if (!KEY.test(key)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid profile key');
  }
}

export async function profileRow(
  conn: Conn,
  localpart: string,
): Promise<Profile | null> {
  const users = await conn.query(
    'SELECT display_name,avatar_url FROM users WHERE localpart=?',
    [localpart],
  );
  if (users.length === 0) return null;
  const profile: Profile = {};
  if (users[0].display_name !== null) {
    profile.displayname = String(users[0].display_name);
  }
  if (users[0].avatar_url !== null) {
    profile.avatar_url = String(users[0].avatar_url);
  }
  for (
    const row of await conn.query(
      'SELECT key,value FROM profile_fields WHERE localpart=?',
      [localpart],
    )
  ) {
    profile[String(row.key)] = JSON.parse(String(row.value));
  }
  return profile;
}

/** undefined means DELETE; null remains JSON null for custom fields. Legacy
 * null retains the established unset behavior on displayname/avatar_url. */
export async function setProfileRow(
  conn: Conn,
  localpart: string,
  key: string,
  value: unknown,
): Promise<void> {
  checkProfileKey(key);
  const legacy = key === 'displayname' || key === 'avatar_url';
  // Synapse-compatible defaults: the field type is enforced, but avatar and
  // timezone strings stay opaque. Semantic validation is optional in the spec.
  if (
    (key === 'avatar_url' || key === 'm.tz') && value !== undefined &&
    typeof value !== 'string'
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', key + ' must be a string');
  }
  if (
    legacy && value !== undefined && value !== null && typeof value !== 'string'
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'legacy profile value must be a string or null',
    );
  }
  const profile = await profileRow(conn, localpart);
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  if (value === undefined || (legacy && value === null)) delete profile[key];
  else profile[key] = value;
  if (encoder.encode(JSON.stringify(profile)).length >= 65536) {
    throw new MatrixError(
      400,
      'M_PROFILE_TOO_LARGE',
      'profile must be under 64 KiB',
    );
  }
  if (legacy) {
    const column = key === 'displayname' ? 'display_name' : 'avatar_url';
    await conn.execute('UPDATE users SET ' + column + '=? WHERE localpart=?', [
      typeof value === 'string' ? value : null,
      localpart,
    ]);
  } else if (value === undefined) {
    await conn.execute(
      'DELETE FROM profile_fields WHERE localpart=? AND key=?',
      [localpart, key],
    );
  } else {
    await conn.execute(
      'INSERT INTO profile_fields(localpart,key,value) VALUES(?,?,?) ON CONFLICT(localpart,key) DO UPDATE SET value=excluded.value',
      [localpart, key, JSON.stringify(value)],
    );
  }
}

export async function clearProfileRows(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM profile_fields WHERE localpart=?', [
    localpart,
  ]);
}

export function getPublicProfile(
  tenant: Tenant,
  localpart: string,
): Promise<Profile | null> {
  return tenant.tx((tx) => tx.profiles.get(localpart));
}

export function setProfileField(
  tenant: Tenant,
  localpart: string,
  key: string,
  value: unknown,
): Promise<void> {
  return tenant.tx((tx) => tx.profiles.set(localpart, key, value));
}
