// The existing immutable device change log owns public semantic export intent.
// Numeric generations are local handles; only the authority fact names a device
// incarnation across nodes. No consuming key inventory enters this record.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn } from '#engine/store/db.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import { appendDeviceChange } from '#engine/tenant/changes.ts';

export type DeviceOperation = {
  version: 1;
  operationId: string;
  source: string;
  incarnation: string;
  sequence: number;
  localpart: string;
  deviceId: string;
  deviceIncarnation: string;
  value: { displayName: string | null; keys: Json | null } | null;
  payloadHash: string;
};

export async function deviceChangeOperation(
  conn: Conn,
  device: DeviceIdentity,
  sequence: number,
  value: DeviceOperation['value'],
): Promise<DeviceOperation | null> {
  const identity = await tenantAuthority(conn);
  if (!identity) return null;
  const [mapping] = await conn.query(
    "SELECT d.incarnation,f.node,f.incarnation AS source_incarnation FROM authority_devices d JOIN authority_facts f ON f.id=d.incarnation AND f.kind='device' AND f.localpart=d.localpart AND json_extract(f.payload,'$.deviceId')=d.device_id WHERE d.localpart=? AND d.device_id=? AND d.generation=?",
    [device.localpart, device.deviceId, device.generation],
  );
  if (
    !mapping || mapping.node !== identity.node ||
    mapping.source_incarnation !== identity.incarnation
  ) {
    throw new Error('public device intent lacks its owning incarnation');
  }
  const body = {
    version: 1 as const,
    operationId: canonicalJson([
      identity.node,
      identity.incarnation,
      'device',
      sequence,
    ]),
    source: identity.node,
    incarnation: identity.incarnation,
    sequence,
    localpart: device.localpart,
    deviceId: device.deviceId,
    deviceIncarnation: String(mapping.incarnation),
    value,
  };
  return {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

/** First export, including an upgrade of an already active F2 owner, captures
 * current material under the registry's exact incarnation. Historical F1 or
 * pre-upgrade rows are never relabeled as globally bound source evidence. */
export async function captureDeviceOperations(
  conn: Conn,
  localpart: string,
): Promise<DeviceOperation[]> {
  const identity = await tenantAuthority(conn);
  if (!identity) return [];
  for (
    const row of await conn.query(
      "SELECT d.device_id,d.generation,a.incarnation FROM devices d LEFT JOIN authority_devices a ON a.localpart=d.localpart AND a.device_id=d.device_id AND a.generation=d.generation WHERE d.localpart=? AND NOT EXISTS(SELECT 1 FROM e2ee_changes c WHERE c.localpart=d.localpart AND c.device_id=d.device_id AND json_extract(c.payload,'$.operation.deviceIncarnation')=a.incarnation)",
      [localpart],
    )
  ) {
    await appendDeviceChange(conn, {
      localpart,
      deviceId: String(row.device_id),
      generation: Number(row.generation),
    });
  }
  return (await conn.query(
    "SELECT payload FROM e2ee_changes WHERE localpart=? AND json_extract(payload,'$.operation.source')=? AND json_extract(payload,'$.operation.incarnation')=? ORDER BY pos",
    [localpart, identity.node, identity.incarnation],
  )).map((row) => JSON.parse(String(row.payload)).operation as DeviceOperation);
}
