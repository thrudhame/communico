// An explicit public projection, not a copied tenant or a second device writer.
// Snapshot and frontier share the source transaction; the receiver has no login,
// device incarnation, consuming pool, private signing view or home identity.
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { splitId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import { signingViews } from './cross-signing.ts';
import { deviceSnapshot, type Json, object } from './e2ee.ts';
import { profileRow, setProfileRow } from './profiles.ts';

export type PublicUserReplica = {
  version: 1;
  userId: string;
  cut: number;
  deactivated: boolean;
  profile: Record<string, unknown>;
  erased: Record<string, unknown> | null;
  devices: Json;
  signing: Json;
};

export async function publicUsers(conn: Conn): Promise<string[]> {
  return (await conn.query('SELECT localpart FROM users ORDER BY localpart'))
    .map((row) => String(row.localpart));
}

export async function readPublicReplica(
  conn: Conn,
  localpart: string,
): Promise<PublicUserReplica | null> {
  const [row] = await conn.query(
    'SELECT snapshot_json FROM public_user_replicas WHERE localpart=?',
    [localpart],
  );
  return row ? JSON.parse(String(row.snapshot_json)) : null;
}

export async function exportPublicUser(
  conn: Conn,
  localpart: string,
  server: string,
): Promise<PublicUserReplica> {
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!user) throw new MatrixError(404, 'M_NOT_FOUND', 'no such user');
  if (await readPublicReplica(conn, localpart)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'a public replica cannot become an export authority',
    );
  }
  const [revision] = await conn.query(
    "SELECT value FROM counters WHERE name='projection_revision'",
  );
  const [erasure] = await conn.query(
    'SELECT room_cuts FROM erased_users WHERE localpart=?',
    [localpart],
  );
  const userId = '@' + localpart + ':' + server;
  return {
    version: 1,
    userId,
    cut: revision ? Number(revision.value) : 0,
    deactivated: Number(user.deactivated) === 1,
    profile: (await profileRow(conn, localpart))!,
    erased: erasure ? JSON.parse(String(erasure.room_cuts)) : null,
    devices: await deviceSnapshot(conn, localpart, userId, config().e2ee),
    signing: await signingViews(conn, localpart, userId, ''),
  };
}

function safeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function publicUserOf(raw: unknown, server: string): PublicUserReplica {
  const input = object(raw, 'public replica');
  const parts = typeof input.userId === 'string' ? splitId(input.userId) : null;
  if (
    input.version !== 1 || !parts || !String(input.userId).startsWith('@') ||
    !parts.localpart || parts.server !== server || !safeInteger(input.cut) ||
    typeof input.deactivated !== 'boolean'
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'invalid public replica identity or cut',
    );
  }
  const profile = object(input.profile, 'public profile');
  const erased = input.erased === null
    ? null
    : object(input.erased, 'erasure facts');
  const devices = object(input.devices, 'public devices');
  const signing = object(input.signing, 'public signing');
  if (
    devices.user_id !== input.userId || !safeInteger(devices.stream_id) ||
    !Array.isArray(devices.devices) ||
    Object.keys(signing).some((usage) =>
      !['master_keys', 'self_signing_keys'].includes(usage)
    )
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid public device snapshot');
  }
  const ids = new Set<string>();
  for (const raw of devices.devices) {
    const device = object(raw, 'public device');
    const keys = object(device.keys, 'public device keys');
    if (
      typeof device.device_id !== 'string' || !device.device_id ||
      ids.has(device.device_id) || keys.device_id !== device.device_id ||
      keys.user_id !== input.userId
    ) {
      throw new MatrixError(400, 'M_BAD_JSON', 'invalid public device owner');
    }
    ids.add(device.device_id);
  }
  for (const raw of Object.values(signing)) {
    if (object(raw, 'public signing key').user_id !== input.userId) {
      throw new MatrixError(400, 'M_BAD_JSON', 'invalid public signing owner');
    }
  }
  return {
    version: 1,
    userId: String(input.userId),
    cut: input.cut,
    deactivated: input.deactivated,
    profile,
    erased,
    devices,
    signing,
  };
}

export async function installPublicUser(
  conn: Conn,
  raw: unknown,
  server: string,
): Promise<void> {
  const view = publicUserOf(raw, server);
  const localpart = splitId(view.userId).localpart;
  const held = await readPublicReplica(conn, localpart);
  const encoded = canonicalJson(view);
  if (
    held &&
    (held.cut > view.cut ||
      (held.cut === view.cut && canonicalJson(held) !== encoded) ||
      Number(held.devices.stream_id) > Number(view.devices.stream_id))
  ) {
    throw new MatrixError(
      409,
      'M_UNKNOWN',
      'regressing or changed public replica cut',
    );
  }
  // Never silently turn a real owned account into a projection.
  if (
    !held &&
    (await conn.query('SELECT 1 FROM users WHERE localpart=?', [localpart]))
      .length
  ) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'public replica cannot replace an owned account',
    );
  }
  await conn.execute(
    'INSERT INTO users(localpart,display_name,avatar_url,deactivated) VALUES(?,NULL,NULL,?) ON CONFLICT(localpart) DO UPDATE SET display_name=NULL,avatar_url=NULL,deactivated=excluded.deactivated',
    [localpart, view.deactivated ? 1 : 0],
  );
  await conn.execute('DELETE FROM profile_fields WHERE localpart=?', [
    localpart,
  ]);
  for (const [key, value] of Object.entries(view.profile)) {
    await setProfileRow(conn, localpart, key, value);
  }
  await conn.execute('DELETE FROM erased_users WHERE localpart=?', [localpart]);
  if (view.erased !== null) {
    await conn.execute(
      'INSERT INTO erased_users(localpart,room_cuts) VALUES(?,?)',
      [localpart, canonicalJson(view.erased)],
    );
  }
  await conn.execute(
    'INSERT INTO public_user_replicas(localpart,source_cut,snapshot_json) VALUES(?,?,?) ON CONFLICT(localpart) DO UPDATE SET source_cut=excluded.source_cut,snapshot_json=excluded.snapshot_json',
    [localpart, view.cut, encoded],
  );
}
