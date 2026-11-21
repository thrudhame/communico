// Public profile storage and atomic whole-profile validation. Membership keeps
// using users.getProfile: custom fields must never enter member event content.
import type { Conn } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  captureRegisterBaseline,
  importRegisterOperation,
  readRegister,
  registerJson,
  type RegisterOperation,
  registerOperations,
  writeRegister,
} from '#engine/facade/registers.ts';
import { tenantAuthority } from './session-authority.ts';
import { requireTenantDomainSource } from './domain-source.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import { recordProfileFanout } from './profile-fanout.ts';
import { changedColumns } from '#engine/store/changed.ts';

export type Profile = Record<string, unknown> & {
  displayname?: string;
  avatar_url?: string;
};
const KEY =
  /^(avatar_url|displayname|m\.tz|[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+)$/;
const encoder = new TextEncoder();

function semanticKey(localpart: string): string {
  return JSON.stringify(['profile', localpart]);
}

function validateProfile(profile: unknown): asserts profile is Profile {
  if (
    profile === null || typeof profile !== 'object' || Array.isArray(profile)
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'profile must be an object');
  }
  for (const [key, value] of Object.entries(profile)) {
    checkProfileKey(key);
    if (
      ['displayname', 'avatar_url', 'm.tz'].includes(key) &&
      typeof value !== 'string'
    ) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'invalid profile field type',
      );
    }
  }
  if (encoder.encode(JSON.stringify(profile)).length >= 65536) {
    throw new MatrixError(
      400,
      'M_PROFILE_TOO_LARGE',
      'profile must be under 64 KiB',
    );
  }
}

async function activeAccount(conn: Conn, localpart: string): Promise<void> {
  const [row] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!row) throw new MatrixError(404, 'M_NOT_FOUND', 'unknown user');
  if (row.deactivated === 1) {
    throw new MatrixError(403, 'M_USER_DEACTIVATED', 'account is deactivated');
  }
}

export function profileOperations(conn: Conn, localpart: string) {
  return registerOperations(conn, semanticKey(localpart));
}

/** Capture the whole validated held profile without inventing a field write or
 * member PDU. The same baseline remains immutable across later source exports. */
export async function captureProfileOperations(conn: Conn, localpart: string) {
  if ((await tenantAuthority(conn))?.node !== 'home') {
    throw new Error('profile bootstrap requires home authority');
  }
  await activeAccount(conn, localpart);
  await baseline(conn, localpart, (await profileRow(conn, localpart))!);
  return await profileOperations(conn, localpart);
}

async function baseline(
  conn: Conn,
  localpart: string,
  held: Profile,
  incoming?: RegisterOperation,
): Promise<void> {
  if ((await profileOperations(conn, localpart)).length) return;
  const authority = (await tenantAuthority(conn))!;
  if (authority.node !== 'home') {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'profile baseline unavailable');
  }
  validateProfile(held);
  await captureRegisterBaseline(
    conn,
    { source: authority.node, incarnation: authority.incarnation },
    semanticKey(localpart),
    'profile',
    JSON.stringify(held),
    incoming,
  );
}

/** Complete validated public value; F1 snapshot installation uses this passive
 * materializer, never a locally authored field mutation. */
export async function materializeProfile(
  conn: Conn,
  localpart: string,
  profile: Profile,
): Promise<void> {
  // The passive legacy representation may contain null unset fields. Normalize
  // them before validating the complete stored profile, as ordinary writes do.
  await replaceProfileRows(conn, localpart, profile);
}

export async function importProfile(
  conn: Conn,
  operation: RegisterOperation,
  history?: DomainHistoryProof,
): Promise<boolean> {
  let address: unknown, profile: unknown;
  try {
    address = JSON.parse(operation.semanticKey);
    profile = JSON.parse(operation.payload);
  } catch {
    throw new Error('invalid profile operation');
  }
  if (
    !Array.isArray(address) || address.length !== 2 ||
    address[0] !== 'profile' ||
    typeof address[1] !== 'string' || !address[1] ||
    operation.semanticKey !== semanticKey(address[1]) ||
    operation.kind !== 'profile'
  ) {
    throw new Error('invalid profile operation');
  }
  validateProfile(profile);
  const localpart = address[1],
    authority = await requireTenantDomainSource(
      conn,
      operation,
      localpart,
      history,
    );
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user) throw new Error('profile account unavailable');
  const held = (await profileRow(conn, localpart))!;
  if (user.deactivated !== 1 && authority!.node === 'home') {
    await baseline(conn, localpart, held, operation);
  }
  await importRegisterOperation(conn, operation);
  if (user.deactivated === 1) return false;
  const winner = (await readRegister(conn, operation.semanticKey)).winner;
  if (!winner || registerJson(JSON.stringify(held)) === winner.payload) {
    return false;
  }
  const selected = JSON.parse(winner.payload);
  await recordProfileFanout(conn, localpart, held, selected);
  await materializeProfile(conn, localpart, selected);
  return true;
}

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
  const previous = { ...profile };
  const prior = profile[key];
  if (
    value === undefined ||
    ((key === 'displayname' || key === 'avatar_url') && value === null)
  ) delete profile[key];
  else profile[key] = value;
  checkSize(profile);
  const authority = await tenantAuthority(conn);
  if (authority) {
    await activeAccount(conn, localpart);
    await baseline(conn, localpart, previous);
    // Even an equal public value can observe and supersede concurrent losers.
    // Passive materialization below still changes only actual field deltas.
    const { winner } = await writeRegister(
      conn,
      { source: authority.node, incarnation: authority.incarnation },
      semanticKey(localpart),
      'profile',
      JSON.stringify(profile),
    );
    if (winner) {
      const selected = JSON.parse(winner.payload);
      await recordProfileFanout(conn, localpart, previous, selected);
      await materializeProfile(conn, localpart, selected);
    }
    return;
  }
  if (
    registerJson(JSON.stringify(prior ?? null)) ===
      registerJson(JSON.stringify(profile[key] ?? null)) &&
    (prior === undefined) === (profile[key] === undefined)
  ) return;
  await recordProfileFanout(conn, localpart, previous, profile);
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
      registerJson(JSON.stringify(before ?? null)) ===
        registerJson(JSON.stringify(after ?? null))
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
  return tenant.tx(async (tx) => {
    await tx.ingress.check({ kind: 'domain-read', localpart });
    return await tx.profiles.get(localpart);
  });
}

export function setProfileField(
  tenant: Tenant,
  localpart: string,
  key: string,
  value: unknown,
): Promise<void> {
  return tenant.tx(async (tx) => {
    await tx.ingress.check({ kind: 'domain', localpart });
    await tx.profiles.set(localpart, key, value);
  });
}
