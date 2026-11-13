// Tenant-owned public keys and consuming pools. All writes use the caller's Conn.
import type { Conn } from '#engine/store/db.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { deviceById } from '#engine/tenant/devices.ts';
import { appendDeviceChange, poolChanged } from '#engine/tenant/changes.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { assertCanonicalNumbers, canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Config } from '#engine/config-schema.ts';
import { config } from '#engine/config.ts';
import { forgetDeviceSignatures } from '#engine/tenant/cross-signing.ts';
import { signatureView } from '#engine/tenant/signature-view.ts';

export type Json = Record<string, unknown>;
export type KeyLimits = Config['e2ee'];
export function object(value: unknown, name: string): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MatrixError(400, 'M_BAD_JSON', name + ' must be an object');
  }
  return value as Json;
}
export function bounded(value: unknown, max: number): void {
  if (new TextEncoder().encode(JSON.stringify(value)).length > max) {
    throw new MatrixError(
      413,
      'M_TOO_LARGE',
      'E2EE object exceeds configured limit',
    );
  }
}
export function limitEntries(count: number, max: number): void {
  if (count > max) {
    throw new MatrixError(413, 'M_TOO_LARGE', 'too many E2EE entries');
  }
}
export function keyId(value: string): [string, string] {
  const colon = value.indexOf(':');
  if (colon < 1 || colon === value.length - 1 || value.length > 512) {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid key ID');
  }
  return [value.slice(0, colon), value.slice(colon + 1)];
}
function signatures(value: unknown): void {
  for (const keys of Object.values(object(value, 'signatures'))) {
    for (const sig of Object.values(object(keys, 'signer keys'))) {
      if (typeof sig !== 'string') {
        throw new MatrixError(400, 'M_BAD_JSON', 'signature must be a string');
      }
    }
  }
}
type PoolKey = { algorithm: string; id: string; json: string };
export type Upload = {
  device: string | null;
  otks: PoolKey[];
  fallbacks: PoolKey[];
  limits: KeyLimits;
};
export function validateUpload(
  value: unknown,
  userId: string,
  deviceId: string,
  limits: KeyLimits,
): Upload {
  bounded(value, limits.maxrequestbytes);
  assertCanonicalNumbers(value);
  const body = object(value, 'body');
  let device: string | null = null;
  if (body.device_keys !== undefined) {
    const key = object(body.device_keys, 'device_keys');
    if (key.user_id !== userId || key.device_id !== deviceId) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'key owner does not match authenticated device',
      );
    }
    if (
      !Array.isArray(key.algorithms) ||
      key.algorithms.some((a) => typeof a !== 'string')
    ) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'algorithms must be an array of strings',
      );
    }
    for (const [id, pub] of Object.entries(object(key.keys, 'keys'))) {
      keyId(id);
      if (typeof pub !== 'string') {
        throw new MatrixError(400, 'M_BAD_JSON', 'public key must be a string');
      }
    }
    signatures(key.signatures);
    bounded(key, limits.maxkeybytes);
    device = canonicalJson(key);
  }
  const parse = (raw: unknown): PoolKey[] =>
    raw === undefined
      ? []
      : Object.entries(object(raw, 'key pool')).map(([name, key]) => {
        const [algorithm, id] = keyId(name);
        if (typeof key !== 'string') {
          const signed = object(key, 'signed key');
          if (
            typeof signed.key !== 'string' ||
            (signed.fallback !== undefined &&
              typeof signed.fallback !== 'boolean')
          ) throw new MatrixError(400, 'M_BAD_JSON', 'invalid signed key');
          signatures(signed.signatures);
        }
        bounded(key, limits.maxkeybytes);
        return { algorithm, id, json: canonicalJson(key) };
      });
  const otks = parse(body.one_time_keys), fallbacks = parse(body.fallback_keys);
  limitEntries(otks.length + fallbacks.length, limits.maxkeys);
  if (
    new Set(fallbacks.map((key) => key.algorithm)).size !== fallbacks.length
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'one fallback per algorithm is allowed',
    );
  }
  return { device, otks, fallbacks, limits };
}

function identity(device: DeviceIdentity): [string, string, number] {
  return [device.localpart, device.deviceId, device.generation];
}
function material(json: string): string {
  const key = JSON.parse(json);
  if (typeof key === 'string') return json;
  const { signatures: _s, unsigned: _u, ...body } = key;
  return canonicalJson(body);
}
export async function current(
  conn: Conn,
  device: DeviceIdentity,
): Promise<void> {
  const row = await deviceById(conn, device.deviceId, device.localpart);
  if (row === null || row.generation !== device.generation) {
    throw new MatrixError(401, 'M_UNKNOWN_TOKEN', 'device no longer exists');
  }
}

export async function uploadKeys(
  conn: Conn,
  device: DeviceIdentity,
  input: Upload,
): Promise<Record<string, number>> {
  await current(conn, device);
  const args = identity(device);
  if (input.device !== null) {
    const old = await conn.query(
      'SELECT key_json FROM device_keys WHERE localpart=? AND device_id=? AND generation=?',
      args,
    );
    if (!old.length || old[0].key_json !== input.device) {
      if (
        old.length &&
        material(String(old[0].key_json)) !== material(input.device)
      ) {
        const rows = await conn.query('SELECT server_name FROM tenant');
        await forgetDeviceSignatures(
          conn,
          '@' + device.localpart + ':' + rows[0].server_name,
          device.deviceId,
          config().federation.bulkmaxbytes,
        );
      }
      await conn.execute(
        'INSERT INTO device_keys VALUES(?,?,?,?) ON CONFLICT(localpart,device_id,generation) DO UPDATE SET key_json=excluded.key_json',
        [...args, input.device],
      );
      await appendDeviceChange(conn, device);
    }
  }
  let changed = false;
  for (const key of input.otks) {
    const old = await conn.query(
      'SELECT key_json FROM one_time_keys WHERE localpart=? AND device_id=? AND generation=? AND algorithm=? AND key_id=?',
      [...args, key.algorithm, key.id],
    );
    if (old.length) {
      if (material(String(old[0].key_json)) !== material(key.json)) {
        throw new MatrixError(
          400,
          'M_INVALID_PARAM',
          'conflicting unclaimed one-time key',
        );
      }
      continue;
    }
    const pos = await nextCounter(conn, 'key_upload');
    await conn.execute('INSERT INTO one_time_keys VALUES(?,?,?,?,?,?,?)', [
      ...args,
      key.algorithm,
      key.id,
      pos,
      key.json,
    ]);
    changed = true;
  }
  for (const key of input.fallbacks) {
    const old = await conn.query(
      'SELECT key_id,key_json FROM fallback_keys WHERE localpart=? AND device_id=? AND generation=? AND algorithm=?',
      [...args, key.algorithm],
    );
    if (
      old.length && old[0].key_id === key.id &&
      material(String(old[0].key_json)) === material(key.json)
    ) continue;
    await conn.execute(
      'INSERT INTO fallback_keys VALUES(?,?,?,?,?,?,0) ON CONFLICT(localpart,device_id,generation,algorithm) DO UPDATE SET key_id=excluded.key_id,key_json=excluded.key_json,used=0',
      [...args, key.algorithm, key.id, key.json],
    );
    changed = true;
  }
  const fallbackCount = await conn.query(
    'SELECT COUNT(*) AS n FROM fallback_keys WHERE localpart=? AND device_id=? AND generation=?',
    args,
  );
  limitEntries(Number(fallbackCount[0].n), input.limits.maxkeys);
  const status = await keyStatus(conn, device);
  limitEntries(
    Object.values(status.counts).reduce((a, b) => a + b, 0),
    input.limits.maxonetimekeys,
  );
  bounded(status, input.limits.maxrequestbytes);
  if (changed) await poolChanged(conn, device);
  return status.counts;
}

export async function keyStatus(
  conn: Conn,
  device: DeviceIdentity,
): Promise<{ counts: Record<string, number>; unused: string[]; seq: number }> {
  const args = identity(device);
  const counts: Record<string, number> = Object.create(null);
  for (
    const row of await conn.query(
      'SELECT algorithm,COUNT(*) AS n FROM one_time_keys WHERE localpart=? AND device_id=? AND generation=? GROUP BY algorithm',
      args,
    )
  ) counts[String(row.algorithm)] = Number(row.n);
  const unused = (await conn.query(
    'SELECT algorithm FROM fallback_keys WHERE localpart=? AND device_id=? AND generation=? AND used=0 ORDER BY algorithm',
    args,
  )).map((row) => String(row.algorithm));
  const seq = await conn.query(
    'SELECT seq FROM key_pool_updates WHERE localpart=? AND device_id=? AND generation=?',
    args,
  );
  return { counts, unused, seq: seq.length ? Number(seq[0].seq) : 0 };
}

export async function queryKeys(
  conn: Conn,
  localpart: string,
  deviceIds: string[],
  requester: string,
  owner: string,
  maxKeys: number,
): Promise<Json> {
  const result: Json = Object.create(null);
  const rows = await conn.query(
    'SELECT d.device_id,d.display_name,k.key_json FROM devices d JOIN device_keys k ON k.localpart=d.localpart AND k.device_id=d.device_id AND k.generation=d.generation WHERE d.localpart=?' +
      (deviceIds.length
        ? ' AND d.device_id IN (' + deviceIds.map(() => '?').join(',') + ')'
        : '') +
      ' ORDER BY d.device_id LIMIT ?',
    [localpart, ...deviceIds, maxKeys + 1],
  );
  limitEntries(rows.length, maxKeys);
  for (const row of rows) {
    if (deviceIds.length && !deviceIds.includes(String(row.device_id))) {
      continue;
    }
    const key = await signatureView(
      conn,
      JSON.parse(String(row.key_json)),
      owner,
      String(row.device_id),
      requester,
    );
    const unsigned: Json = key.unsigned && typeof key.unsigned === 'object' &&
        !Array.isArray(key.unsigned)
      ? key.unsigned as Json
      : {};
    delete unsigned.device_display_name;
    if (row.display_name !== null) {
      unsigned.device_display_name = String(row.display_name);
    }
    key.unsigned = unsigned;
    result[String(row.device_id)] = key;
  }
  return result;
}

/** The list and causal anchor are captured on the same tenant connection. */
export async function deviceSnapshot(
  conn: Conn,
  localpart: string,
  owner: string,
  limits: KeyLimits,
): Promise<Json> {
  const keys = await queryKeys(conn, localpart, [], '', owner, limits.maxkeys);
  const rows = await conn.query(
    'SELECT value FROM user_device_stream WHERE localpart=?',
    [localpart],
  );
  const devices = Object.entries(keys).map(([device_id, value]) => {
    const key = value as Json;
    const unsigned = key.unsigned as Json;
    return {
      device_id,
      keys: key,
      ...(unsigned.device_display_name === undefined
        ? {}
        : { device_display_name: unsigned.device_display_name }),
    };
  });
  const response = {
    user_id: owner,
    stream_id: rows.length ? Number(rows[0].value) : 0,
    devices,
  };
  bounded(response, limits.maxrequestbytes);
  return response;
}

/** Shared consuming primitive for C-S and federation; empty means exhaustion. */
export async function claimKey(
  conn: Conn,
  localpart: string,
  deviceId: string,
  algorithm: string,
): Promise<Json | null> {
  const row = await deviceById(conn, deviceId, localpart);
  if (row === null) return null;
  const device = { localpart, deviceId, generation: row.generation },
    args = identity(device);
  const keys = await conn.query(
    'SELECT key_id,key_json FROM one_time_keys WHERE localpart=? AND device_id=? AND generation=? AND algorithm=? ORDER BY upload_pos,key_id LIMIT 1',
    [...args, algorithm],
  );
  if (keys.length) {
    await conn.execute(
      'DELETE FROM one_time_keys WHERE localpart=? AND device_id=? AND generation=? AND algorithm=? AND key_id=?',
      [...args, algorithm, keys[0].key_id],
    );
    await poolChanged(conn, device);
    return {
      [algorithm + ':' + keys[0].key_id]: JSON.parse(String(keys[0].key_json)),
    };
  }
  const fallback = await conn.query(
    'SELECT key_id,key_json,used FROM fallback_keys WHERE localpart=? AND device_id=? AND generation=? AND algorithm=?',
    [...args, algorithm],
  );
  if (!fallback.length) return null;
  if (Number(fallback[0].used) === 0) {
    await conn.execute(
      'UPDATE fallback_keys SET used=1 WHERE localpart=? AND device_id=? AND generation=? AND algorithm=?',
      [...args, algorithm],
    );
    await poolChanged(conn, device);
  }
  return {
    [algorithm + ':' + fallback[0].key_id]: JSON.parse(
      String(fallback[0].key_json),
    ),
  };
}
