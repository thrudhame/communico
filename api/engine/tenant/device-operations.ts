// Public semantic device owner. Link adapters authenticate the source envelope;
// the tenant validates its exact incarnation before retaining public material.
// Foreign public facts never create a mutable device, session or consuming pool.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import type { DeviceOperation } from '#engine/tenant/device-source.ts';
import { KeyHistoryProof } from '#engine/tenant/key-bootstrap.ts';
import {
  deviceWireOf,
  retainDeviceWire,
} from '#engine/tenant/device-stream.ts';
import { type Json, object, validateUpload } from '#engine/tenant/e2ee.ts';
import { appendImportedKeyNotice } from '#engine/tenant/changes.ts';
import {
  registryDevice,
  tenantAuthority,
} from '#engine/tenant/session-authority.ts';

export const DEVICE_OPERATIONS_SQL = `
CREATE TABLE device_operations(operation_id TEXT PRIMARY KEY NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,sequence INTEGER NOT NULL,localpart TEXT NOT NULL,device_id TEXT NOT NULL,device_incarnation TEXT NOT NULL,payload_hash TEXT NOT NULL,payload_json TEXT NOT NULL,UNIQUE(source,incarnation,sequence));
CREATE INDEX device_operations_account ON device_operations(localpart,device_id,device_incarnation,sequence);
`;

function collision(): never {
  throw new MatrixError(409, 'M_UNKNOWN', 'device operation collision');
}

function deviceOperationOf(raw: unknown, server: string): DeviceOperation {
  const row = object(raw, 'device operation');
  for (
    const key of [
      'source',
      'incarnation',
      'localpart',
      'deviceId',
      'deviceIncarnation',
    ]
  ) {
    if (typeof row[key] !== 'string' || !row[key]) collision();
  }
  if (
    row.version !== 1 || !Number.isSafeInteger(row.sequence) ||
    Number(row.sequence) < 1
  ) collision();
  let value: DeviceOperation['value'] = null;
  if (row.value !== null) {
    const input = object(row.value, 'device operation value');
    if (input.displayName !== null && typeof input.displayName !== 'string') {
      collision();
    }
    if (input.keys !== null) {
      object(input.keys, 'device operation keys');
      validateUpload(
        { device_keys: input.keys },
        '@' + row.localpart + ':' + server,
        String(row.deviceId),
        config().e2ee,
      );
    }
    value = {
      displayName: input.displayName as string | null,
      keys: input.keys as Json | null,
    };
    if (canonicalJson(value) !== canonicalJson(input)) collision();
  }
  const body = {
    version: 1 as const,
    operationId: canonicalJson([
      row.source,
      row.incarnation,
      'device',
      row.sequence,
    ]),
    source: String(row.source),
    incarnation: String(row.incarnation),
    sequence: Number(row.sequence),
    localpart: String(row.localpart),
    deviceId: String(row.deviceId),
    deviceIncarnation: String(row.deviceIncarnation),
    value,
    ...(Object.hasOwn(row, 'wire') ? { wire: deviceWireOf(row.wire) } : {}),
  };
  const operation = {
    ...body,
    payloadHash: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
  if (canonicalJson(operation) !== canonicalJson(raw)) collision();
  return operation;
}

export async function importDeviceOperation(
  conn: Conn,
  raw: unknown,
  expected: { source: string; incarnation: string; localpart: string },
  history?: KeyHistoryProof,
): Promise<void> {
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  const operation = deviceOperationOf(raw, String(tenant.server_name));
  const identity = await tenantAuthority(conn);
  if (!identity) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'device operation awaits authority',
    );
  }
  if (history) {
    if (!(history instanceof KeyHistoryProof)) collision();
    await history.require(conn, 'device-operation', operation);
  }
  if (
    operation.source !== expected.source ||
    operation.incarnation !== expected.incarnation ||
    operation.localpart !== expected.localpart || (!history && !(
      (operation.source === 'home' &&
        operation.incarnation === identity.homeIncarnation) ||
      (operation.source === identity.edgeNode &&
        operation.incarnation === identity.edgeIncarnation)
    ))
  ) collision();
  const [activeCreation] = await conn.query(
    "SELECT node,incarnation,payload FROM authority_facts WHERE id=? AND localpart=? AND kind='device'",
    [operation.deviceIncarnation, operation.localpart],
  );
  const historicalCreation = history
    ? await history.retainCreation(conn, operation)
    : undefined;
  const creation = historicalCreation
    ? {
      node: historicalCreation.node,
      incarnation: historicalCreation.incarnation,
      payload: canonicalJson(historicalCreation),
    }
    : activeCreation;
  if (!creation) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'device operation awaits incarnation',
    );
  }
  if (
    creation.node !== operation.source ||
    creation.incarnation !== operation.incarnation ||
    JSON.parse(String(creation.payload)).deviceId !== operation.deviceId
  ) collision();
  const encoded = canonicalJson(operation);
  // Source and imported logs share one identity namespace. A home-attested
  // return of this owner's original history cannot replace it with a tombstone.
  const [local] = await conn.query(
    "SELECT json_extract(payload,'$.operation') AS payload_json FROM e2ee_changes WHERE json_extract(payload,'$.operation.operationId')=?",
    [operation.operationId],
  );
  if (
    local && canonicalJson(JSON.parse(String(local.payload_json))) !== encoded
  ) collision();
  const [old] = await conn.query(
    'SELECT payload_json FROM device_operations WHERE operation_id=?',
    [operation.operationId],
  );
  if (old) {
    if (old.payload_json !== encoded) collision();
    return;
  }
  if (operation.wire) {
    await retainDeviceWire(
      conn,
      operation.localpart,
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.wire,
      history ? { proof: history, operation } : undefined,
    );
  }
  await conn.execute(
    'INSERT INTO device_operations VALUES(?,?,?,?,?,?,?,?,?)',
    [
      operation.operationId,
      operation.source,
      operation.incarnation,
      operation.sequence,
      operation.localpart,
      operation.deviceId,
      operation.deviceIncarnation,
      operation.payloadHash,
      encoded,
    ],
  );
  if (!local) {
    await appendImportedKeyNotice(
      conn,
      operation.localpart,
      '@' + operation.localpart + ':' + tenant.server_name,
      true,
    );
  }
}

/** Source sequences order one incarnation's owner writes only. Registry
 * selection and remove-wins tombstones decide existence; no maximum across
 * independent owner counters, copied generation or F1 snapshot can decide it.
 * The signed bootstrap/link and coherent wire-cut owners compose this view. */
export async function publicDeviceValues(
  conn: Conn,
  localpart: string,
): Promise<DeviceOperation[]> {
  const [user] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (user?.deactivated === 1) return [];
  const identity = await tenantAuthority(conn);
  if (!identity) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'device operation awaits authority',
    );
  }
  const local = (await conn.query(
    "SELECT payload FROM e2ee_changes WHERE localpart=? AND json_extract(payload,'$.operation.source')=? AND json_extract(payload,'$.operation.incarnation')=?",
    [localpart, identity.node, identity.incarnation],
  )).map((row) => JSON.parse(String(row.payload)).operation as DeviceOperation);
  const imported = (await conn.query(
    'SELECT payload_json FROM device_operations WHERE localpart=?',
    [localpart],
  )).map((row) => JSON.parse(String(row.payload_json)) as DeviceOperation);
  const latest = new Map<string, DeviceOperation>(),
    deleted = new Set<string>();
  for (const operation of [...local, ...imported]) {
    if (operation.value === null) deleted.add(operation.deviceIncarnation);
    const prior = latest.get(operation.deviceIncarnation);
    if (!prior || operation.sequence > prior.sequence) {
      latest.set(operation.deviceIncarnation, operation);
    }
  }
  for (
    const row of await conn.query(
      "SELECT json_extract(payload,'$.target') AS target FROM authority_facts WHERE localpart=? AND kind='delete'",
      [localpart],
    )
  ) deleted.add(String(row.target));
  const result: DeviceOperation[] = [];
  for (const operation of latest.values()) {
    if (
      deleted.has(operation.deviceIncarnation) ||
      (await registryDevice(conn, localpart, operation.deviceId))?.id !==
        operation.deviceIncarnation
    ) continue;
    result.push(operation);
  }
  return result.sort((a, b) =>
    a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0
  );
}

/** Current local material needs no export side effect on a read. Registry
 * binding, not local possession or an imported F1 snapshot, controls inclusion. */
export async function publicDeviceKeys(conn: Conn, localpart: string) {
  const identity = await tenantAuthority(conn);
  if (!identity) return null;
  const [account] = await conn.query(
    'SELECT deactivated FROM users WHERE localpart=?',
    [localpart],
  );
  if (!account || account.deactivated === 1) return [];
  const values = new Map<
    string,
    {
      device_id: string;
      display_name: string | null;
      key_json: string;
      generation?: number;
    }
  >();
  for (const operation of await publicDeviceValues(conn, localpart)) {
    if (operation.value?.keys) {
      values.set(operation.deviceId, {
        device_id: operation.deviceId,
        display_name: operation.value.displayName,
        key_json: canonicalJson(operation.value.keys),
      });
    }
  }
  for (
    const row of await conn.query(
      'SELECT d.device_id,d.display_name,d.generation,k.key_json,a.incarnation FROM devices d JOIN device_keys k ON k.localpart=d.localpart AND k.device_id=d.device_id AND k.generation=d.generation JOIN authority_devices a ON a.localpart=d.localpart AND a.device_id=d.device_id AND a.generation=d.generation WHERE d.localpart=?',
      [localpart],
    )
  ) {
    const creation = await registryDevice(
      conn,
      localpart,
      String(row.device_id),
    );
    const removed = await conn.query(
      "SELECT 1 FROM authority_facts WHERE localpart=? AND kind='delete' AND json_extract(payload,'$.target')=? UNION ALL SELECT 1 FROM device_operations WHERE localpart=? AND device_incarnation=? AND json_type(payload_json,'$.value')='null' UNION ALL SELECT 1 FROM e2ee_changes WHERE localpart=? AND json_extract(payload,'$.operation.deviceIncarnation')=? AND json_type(payload,'$.operation.value')='null' LIMIT 1",
      [
        localpart,
        row.incarnation,
        localpart,
        row.incarnation,
        localpart,
        row.incarnation,
      ],
    );
    if (
      !removed.length && creation?.id === row.incarnation &&
      creation.node === identity.node &&
      creation.incarnation === identity.incarnation
    ) {
      values.set(String(row.device_id), {
        device_id: String(row.device_id),
        display_name: row.display_name === null
          ? null
          : String(row.display_name),
        key_json: String(row.key_json),
        generation: Number(row.generation),
      });
    }
  }
  return [...values.values()].sort((a, b) =>
    a.device_id < b.device_id ? -1 : a.device_id > b.device_id ? 1 : 0
  );
}
