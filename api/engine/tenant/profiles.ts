// Public profile storage and atomic whole-profile validation. Membership keeps
// using users.getProfile: custom fields must never enter member event content.
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { changedColumns } from '#engine/store/changed.ts';

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
function checkField(key: string, value: unknown): void {
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
}

function checkSize(profile: Profile): void {
  if (encoder.encode(JSON.stringify(profile)).length >= 65536) {
    throw new MatrixError(
      400,
      'M_PROFILE_TOO_LARGE',
      'profile must be under 64 KiB',
    );
  }
}

async function writeField(
  conn: Conn,
  localpart: string,
  key: string,
  value: unknown,
) {
  if (key === 'displayname' || key === 'avatar_url') {
    const column = key === 'displayname' ? 'display_name' : 'avatar_url';
    const stored = typeof value === 'string' ? value : null;
    await conn.execute(
      'UPDATE users SET ' + column + '=? WHERE localpart=? AND ' + column +
        ' IS NOT ?',
      [stored, localpart, stored],
    );
  } else if (value === undefined) {
    await conn.execute(
      'DELETE FROM profile_fields WHERE localpart=? AND key=?',
      [localpart, key],
    );
  } else {
    await conn.execute(
      'INSERT INTO profile_fields(localpart,key,value) VALUES(?,?,?) ON CONFLICT(localpart,key) DO UPDATE SET value=excluded.value WHERE ' +
        changedColumns('profile_fields', 'value'),
      [localpart, key, JSON.stringify(value)],
    );
  }
}

export async function setProfileRow(
  conn: Conn,
  localpart: string,
  key: string,
  value: unknown,
): Promise<void> {
  checkField(key, value);
  const profile = await profileRow(conn, localpart);
  if (profile === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  }
  const prior = profile[key];
  if (
    value === undefined ||
    ((key === 'displayname' || key === 'avatar_url') && value === null)
  ) delete profile[key];
  else profile[key] = value;
  checkSize(profile);
  if (
    canonicalJson(prior ?? null) === canonicalJson(profile[key] ?? null) &&
    (prior === undefined) === (profile[key] === undefined)
  ) return;
  await writeField(conn, localpart, key, value);
}

/** Authoritative profile replacement validates the final assembled value once,
 * then applies only material field differences inside the caller's transaction. */
export async function replaceProfileRows(
  conn: Conn,
  localpart: string,
  raw: Profile,
): Promise<void> {
  const next: Profile = {};
  for (const [key, value] of Object.entries(raw)) {
    checkField(key, value);
    if (
      value !== undefined &&
      !((key === 'displayname' || key === 'avatar_url') && value === null)
    ) next[key] = value;
  }
  checkSize(next);
  const prior = await profileRow(conn, localpart);
  if (prior === null) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  for (const key of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    const before = prior[key], after = next[key];
    if (
      (before === undefined) === (after === undefined) &&
      canonicalJson(before ?? null) === canonicalJson(after ?? null)
    ) continue;
    await writeField(conn, localpart, key, after);
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
