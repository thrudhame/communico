// api/engine/tenant/devices.ts — device rows and their cascade: deleting
// devices removes their tokens (and those tokens' pushers and refresh
// rows) with them.
import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { appendDeviceChange } from '#engine/tenant/changes.ts';
import {
  forgetDeviceSignatures,
  signingCollision,
} from '#engine/tenant/cross-signing.ts';
import { config } from '#engine/config.ts';
import { deletePushersForToken } from '#engine/tenant/pushers.ts';

export type DeviceRow = {
  device_id: string;
  generation: number;
  display_name: string | null;
};

export type DeviceIdentity = {
  localpart: string;
  deviceId: string;
  generation: number;
};

function deviceRow(row: Record<string, unknown>): DeviceRow {
  return {
    device_id: String(row.device_id),
    generation: Number(row.generation),
    display_name: row.display_name == null ? null : String(row.display_name),
  };
}

// --- conn-level rows (bound on TenantTx) -----------------------------------

// Upsert keeping an existing display name when none is given (register
// passes one explicitly; the login path does not).
export async function upsertDeviceRow(
  conn: Conn,
  deviceId: string,
  localpart: string,
  displayName: string | null,
): Promise<void> {
  await signingCollision(conn, localpart, deviceId);
  const existing = await deviceById(conn, deviceId, localpart);
  if (existing !== null) {
    if (displayName !== null) {
      await renameDevice(conn, deviceId, localpart, displayName);
    }
    return;
  }
  const generation = await nextCounter(conn, 'device_generation');
  await conn.execute(
    'INSERT INTO devices(device_id, localpart, generation, display_name) VALUES(?,?,?,?)',
    [deviceId, localpart, generation, displayName],
  );
  await appendDeviceChange(conn, { localpart, deviceId, generation });
}

export async function deviceById(
  conn: Conn,
  deviceId: string,
  localpart: string,
): Promise<DeviceRow | null> {
  const rows = await conn.query(
    'SELECT device_id, generation, display_name FROM devices WHERE device_id = ? AND localpart = ?',
    [deviceId, localpart],
  );
  return rows.length === 0 ? null : deviceRow(rows[0]);
}

export async function devicesOfUser(
  conn: Conn,
  localpart: string,
): Promise<DeviceRow[]> {
  const rows = await conn.query(
    'SELECT device_id, generation, display_name FROM devices WHERE localpart = ? ORDER BY device_id',
    [localpart],
  );
  return rows.map(deviceRow);
}

export async function renameDevice(
  conn: Conn,
  deviceId: string,
  localpart: string,
  displayName: string,
): Promise<boolean> {
  const device = await deviceById(conn, deviceId, localpart);
  if (device === null) return false;
  if (device.display_name === displayName) return true;
  await conn.execute(
    'UPDATE devices SET display_name = ? WHERE device_id = ? AND localpart = ?',
    [displayName, deviceId, localpart],
  );
  await appendDeviceChange(conn, {
    localpart,
    deviceId,
    generation: device.generation,
  });
  return true;
}

export async function deleteDevice(
  conn: Conn,
  deviceId: string,
  localpart: string,
): Promise<void> {
  // Sole device lifecycle deletion: all consumers revoke through this owner.
  await conn.execute(
    'DELETE FROM delayed_event_receipts WHERE localpart=? AND device_id=?',
    [localpart, deviceId],
  );
  const device = await deviceById(conn, deviceId, localpart);
  await conn.execute(
    'DELETE FROM sliding_sync_positions WHERE connection_id IN (SELECT id FROM sliding_sync_connections WHERE localpart=? AND device_id=?)',
    [localpart, deviceId],
  );
  await conn.execute(
    'DELETE FROM sliding_sync_connections WHERE localpart=? AND device_id=?',
    [localpart, deviceId],
  );
  const tenant = await conn.query('SELECT server_name FROM tenant');
  await forgetDeviceSignatures(
    conn,
    '@' + localpart + ':' + tenant[0].server_name,
    deviceId,
    config().federation.bulkmaxbytes,
  );
  const tokens = await conn.query(
    'SELECT token FROM access_tokens WHERE localpart = ? AND device_id = ?',
    [localpart, deviceId],
  );
  for (const row of tokens) {
    await deletePushersForToken(conn, String(row.token));
    await conn.execute('DELETE FROM refresh_tokens WHERE access_token = ?', [
      row.token,
    ]);
  }
  await conn.execute(
    'DELETE FROM refresh_tokens WHERE localpart = ? AND device_id = ?',
    [localpart, deviceId],
  );
  await conn.execute(
    'DELETE FROM access_tokens WHERE localpart = ? AND device_id = ?',
    [localpart, deviceId],
  );
  await conn.execute(
    'DELETE FROM transactions WHERE localpart = ? AND device_id = ?',
    [localpart, deviceId],
  );
  for (
    const table of [
      'device_keys',
      'one_time_keys',
      'fallback_keys',
      'key_pool_updates',
      'to_device_inbox',
      'to_device_transactions',
      'sync_deliveries',
      'device_ack',
    ]
  ) {
    await conn.execute(
      `DELETE FROM ${table} WHERE localpart=? AND device_id=?`,
      [localpart, deviceId],
    );
  }
  if (device !== null) {
    await appendDeviceChange(conn, {
      localpart,
      deviceId,
      generation: device.generation,
    }, true);
  }
  await conn.execute(
    'DELETE FROM devices WHERE device_id = ? AND localpart = ?',
    [deviceId, localpart],
  );
}

export async function deleteDevicesOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  for (const row of await devicesOfUser(conn, localpart)) {
    await deleteDevice(conn, row.device_id, localpart);
  }
}

// --- tenant-level behaviour --------------------------------------------------

/** Create or re-attach a device; an omitted display name keeps the old. */
export async function upsertDevice(
  tenant: Tenant,
  localpart: string,
  deviceId: string,
  displayName?: string,
): Promise<void> {
  await tenant.tx((tx) =>
    tx.devices.upsert(deviceId, localpart, displayName ?? null)
  );
}

/** One device the localpart owns; null = not found/not owned. */
export async function getDevice(
  tenant: Tenant,
  localpart: string,
  deviceId: string,
): Promise<Omit<DeviceRow, 'generation'> | null> {
  const row = await tenant.tx((tx) => tx.devices.byId(deviceId, localpart));
  return row === null
    ? null
    : { device_id: row.device_id, display_name: row.display_name };
}

export async function listDevices(
  tenant: Tenant,
  localpart: string,
): Promise<Omit<DeviceRow, 'generation'>[]> {
  return (await tenant.tx((tx) => tx.devices.ofUser(localpart))).map((row) => ({
    device_id: row.device_id,
    display_name: row.display_name,
  }));
}

/** Rename a device the localpart owns; false = not owned/not found. */
export async function updateDeviceName(
  tenant: Tenant,
  localpart: string,
  deviceId: string,
  displayName: string,
): Promise<boolean> {
  return await tenant.tx((tx) =>
    tx.devices.rename(deviceId, localpart, displayName)
  );
}

/** Delete the named devices of localpart — their tokens and the tokens'
 * pushers and refresh rows go with them. */
export async function deleteDevices(
  tenant: Tenant,
  localpart: string,
  deviceIds: string[],
): Promise<void> {
  await tenant.tx(async (tx) => {
    for (const deviceId of deviceIds) {
      await tx.devices.delete(deviceId, localpart);
    }
  });
}
