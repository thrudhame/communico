import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { signatureView } from '#engine/tenant/signature-view.ts';
import { config } from '#engine/config.ts';
import { bounded } from '#engine/tenant/e2ee.ts';
import { encodeEnvelope } from '#engine/federation-envelope.ts';

/** Private restore candidate only; immutable reset intents project before serving. */
export async function rebaseRestoredDeviceStreams(
  conn: Conn,
): Promise<{ users: number; floor: number }> {
  const [{ head }] = await conn.query(
    'SELECT COALESCE(MAX(value),0) AS head FROM user_device_stream',
  );
  // A microsecond wall-clock anchor moves a restored counter out of its old
  // incremental range. Numeric ordering alone cannot prove unseen peer state:
  // the empty predecessor reset below is the authoritative recovery boundary.
  const floor = Math.max(
    Math.floor((performance.timeOrigin + performance.now()) * 1000),
    Number(head) + 1,
  );
  if (!Number.isSafeInteger(floor) || floor >= Number.MAX_SAFE_INTEGER) {
    throw new Error('restored device stream exceeds supported integer range');
  }
  let cursor: string | null = null, users = 0;
  for (;;) {
    const rows = await conn.query(
      'SELECT localpart FROM (SELECT localpart FROM users UNION SELECT localpart FROM user_device_stream) WHERE (? IS NULL OR localpart>?) ORDER BY localpart LIMIT 256',
      [cursor, cursor],
    );
    if (!rows.length) break;
    for (const row of rows) {
      const localpart = String(row.localpart);
      await conn.execute(
        'INSERT INTO user_device_stream VALUES(?,?) ON CONFLICT(localpart) DO UPDATE SET value=excluded.value',
        [localpart, floor],
      );
      await conn.execute('INSERT INTO e2ee_changes VALUES(?,?,?,?,?,?)', [
        await nextCounter(conn, 'e2ee_changes'),
        localpart,
        '',
        0,
        floor,
        '{"kind":"restore_reset","device_id":"","deleted":true}',
      ]);
      users++;
    }
    cursor = String(rows.at(-1)!.localpart);
  }
  return { users, floor };
}

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
      const tenant = await conn.query('SELECT server_name FROM tenant');
      if (tenant.length !== 1) throw new Error('tenant identity missing');
      payload.keys = await signatureView(
        conn,
        JSON.parse(String(rows[0].key_json)),
        '@' + device.localpart + ':' + tenant[0].server_name,
        device.deviceId,
      );
    }
  }
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  const server = String(tenant.server_name);
  const { generation: _generation, ...wire } = payload;
  void _generation;
  // Like to-device and public signing, reject undeliverable snapshots in their
  // owning transaction, before accepting a durable reliable obligation. Reserve
  // the widest timestamps/stream IDs and causal predecessor, including resets.
  bounded(
    JSON.parse(encodeEnvelope(server, Number.MAX_SAFE_INTEGER, [], [{
      edu_type: 'm.device_list_update',
      content: {
        ...wire,
        user_id: '@' + device.localpart + ':' + server,
        stream_id: Number.MAX_SAFE_INTEGER,
        prev_id: [Number.MAX_SAFE_INTEGER],
      },
    }])),
    config().federation.bulkmaxbytes,
  );
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
