// api/engine/tenant/devices.ts — device rows and their cascade: deleting
// devices removes their tokens (and those tokens' pushers and refresh
// rows) with them.
import type { Conn } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { revokeDeviceTokens } from '#engine/tenant/auth.ts';
import type { Tenant } from '#engine/tenant/index.ts';

export type DeviceRow = {
  device_id: string;
  display_name: string | null;
};

function deviceRow(row: Record<string, unknown>): DeviceRow {
  return {
    device_id: String(row.device_id),
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
  const changed = await conn.execute(
    'INSERT INTO devices (device_id, localpart, display_name) VALUES (?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET display_name = COALESCE(excluded.display_name, devices.display_name) WHERE devices.localpart = excluded.localpart',
    [deviceId, localpart, displayName],
  );
  if (changed === 0) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'device ID belongs to another user',
    );
  }
}

export async function deviceById(
  conn: Conn,
  deviceId: string,
  localpart: string,
): Promise<DeviceRow | null> {
  const rows = await conn.query(
    'SELECT device_id, display_name FROM devices WHERE device_id = ? AND localpart = ?',
    [deviceId, localpart],
  );
  return rows.length === 0 ? null : deviceRow(rows[0]);
}

export async function devicesOfUser(
  conn: Conn,
  localpart: string,
): Promise<DeviceRow[]> {
  const rows = await conn.query(
    'SELECT device_id, display_name FROM devices WHERE localpart = ? ORDER BY device_id',
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
  return (await conn.execute(
    'UPDATE devices SET display_name = ? WHERE device_id = ? AND localpart = ?',
    [displayName, deviceId, localpart],
  )) > 0;
}

export async function deleteDevice(
  conn: Conn,
  deviceId: string,
): Promise<void> {
  await conn.execute('DELETE FROM devices WHERE device_id = ?', [deviceId]);
}

export async function deleteDeviceOwned(
  conn: Conn,
  deviceId: string,
  localpart: string,
): Promise<void> {
  await conn.execute(
    'DELETE FROM devices WHERE device_id = ? AND localpart = ?',
    [deviceId, localpart],
  );
}

export async function deleteDevicesOfUser(
  conn: Conn,
  localpart: string,
): Promise<void> {
  await conn.execute('DELETE FROM devices WHERE localpart = ?', [localpart]);
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
): Promise<DeviceRow | null> {
  return await tenant.tx((tx) => tx.devices.byId(deviceId, localpart));
}

export async function listDevices(
  tenant: Tenant,
  localpart: string,
): Promise<DeviceRow[]> {
  return await tenant.tx((tx) => tx.devices.ofUser(localpart));
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
      await revokeDeviceTokens(tx, deviceId, localpart);
      await tx.devices.deleteOwned(deviceId, localpart);
    }
  });
}
