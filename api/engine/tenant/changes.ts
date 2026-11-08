import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { canonicalJson } from '#engine/canonical.ts';

/** Immutable public snapshot/tombstone, committed with its owning mutation. */
export async function appendDeviceChange(
  conn: Conn,
  device: DeviceIdentity,
  deleted = false,
): Promise<void> {
  const rows = deleted ? [] : await conn.query(
    'SELECT d.display_name,k.key_json FROM devices d LEFT JOIN device_keys k ON k.localpart=d.localpart AND k.device_id=d.device_id AND k.generation=d.generation WHERE d.localpart=? AND d.device_id=? AND d.generation=?',
    [device.localpart, device.deviceId, device.generation],
  );
  await conn.execute(
    'INSERT INTO user_device_stream(localpart,value) VALUES(?,1) ON CONFLICT(localpart) DO UPDATE SET value=user_device_stream.value+1',
    [device.localpart],
  );
  const stream = await conn.query(
    'SELECT value FROM user_device_stream WHERE localpart=?',
    [device.localpart],
  );
  const pos = await nextCounter(conn, 'e2ee_changes');
  const payload: Record<string, unknown> = {
    device_id: device.deviceId,
    generation: device.generation,
  };
  if (deleted) payload.deleted = true;
  else {
    if (rows.length !== 1) throw new Error('device snapshot missing');
    if (rows[0].display_name !== null) {
      payload.device_display_name = rows[0].display_name;
    }
    if (rows[0].key_json !== null) {
      payload.keys = JSON.parse(String(rows[0].key_json));
    }
  }
  await conn.execute('INSERT INTO e2ee_changes VALUES(?,?,?,?,?,?)', [
    pos,
    device.localpart,
    device.deviceId,
    device.generation,
    Number(stream[0].value),
    canonicalJson(payload),
  ]);
}

export async function poolChanged(
  conn: Conn,
  device: DeviceIdentity,
): Promise<void> {
  const seq = await nextCounter(conn, 'key_pools');
  await conn.execute(
    'INSERT INTO key_pool_updates VALUES(?,?,?,?) ON CONFLICT(localpart,device_id,generation) DO UPDATE SET seq=excluded.seq',
    [device.localpart, device.deviceId, device.generation, seq],
  );
}
