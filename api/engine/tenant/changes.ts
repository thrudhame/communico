import type { Conn } from '#engine/store/db.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { signatureView } from '#engine/tenant/signature-view.ts';
import { config } from '#engine/config.ts';
import { bounded } from '#engine/tenant/e2ee.ts';
import { encodeEnvelope } from '#engine/federation-envelope.ts';
import { deviceChangeOperation } from '#engine/tenant/device-source.ts';
import type { Json } from '#engine/tenant/e2ee.ts';
import type { SignatureOperation } from '#engine/tenant/signature-operations.ts';
import {
  allocateDeviceWire,
  type DeviceWire,
  retainDeviceWire,
} from '#engine/tenant/device-stream.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import { recordTenantProjection } from '#engine/tenant/hooks.ts';
import { publicDeviceKeys } from '#engine/tenant/device-operations.ts';

/** A transaction-local cut for classifying committed public key invalidations.
 * This is receiver discovery only, never a federation stream or auth revision. */
export async function keyChangesCut(conn: Conn): Promise<number> {
  const [row] = await conn.query(
    'SELECT COALESCE(MAX(pos),0) AS pos FROM e2ee_changes',
  );
  return Number(row.pos);
}

export async function publicKeysChangedAfter(
  conn: Conn,
  cut: number,
): Promise<boolean> {
  return (await conn.query(
    "SELECT 1 FROM e2ee_changes WHERE pos>? AND (json_extract(payload,'$.kind') IS NULL OR json_extract(payload,'$.kind') IN ('public_signing','restore_reset','semantic_reset') OR (json_extract(payload,'$.kind')='imported_keys' AND json_extract(payload,'$.public')=1)) LIMIT 1",
    [cut],
  )).length > 0;
}

/** Imported public facts create receiver-local invalidations, not new semantic
 * operations or federation identities. The original wire remains with its owner.
 * Retain discovery in the same transaction so ACK loss/restart cannot hide news.
 * Stale local wire snapshots need a separate correction, never a rewritten fact. */
export async function appendImportedKeyNotice(
  conn: Conn,
  localpart: string,
  subject: string,
  publicChanged: boolean,
): Promise<void> {
  await conn.execute('INSERT INTO e2ee_changes VALUES(?,?,?,?,?,?)', [
    await nextCounter(conn, 'e2ee_changes'),
    localpart,
    '',
    0,
    0,
    canonicalJson({ kind: 'imported_keys', subject, public: publicChanged }),
  ]);
  await recordTenantProjection(conn);
  if (publicChanged) await reconcileDevicePublications(conn, localpart);
}

/** Immutable source snapshots cannot be changed when later semantic material
 * invalidates them. Join that reconciliation with one new durable reset instead.
 * A reset covers every older source snapshot; replay cannot mint an echo loop. */
export async function reconcileDevicePublications(
  conn: Conn,
  localpart: string,
): Promise<void> {
  const latest = new Map<string, Record<string, unknown>>();
  for (
    const row of await conn.query(
      "SELECT device_id,payload FROM e2ee_changes WHERE localpart=? AND stream_id>0 AND json_type(payload,'$.wire')='object' ORDER BY pos",
      [localpart],
    )
  ) {
    const payload = JSON.parse(String(row.payload));
    if (payload.kind === 'restore_reset' || payload.kind === 'semantic_reset') {
      latest.clear();
    } else if (row.device_id) latest.set(String(row.device_id), payload);
  }
  if (!latest.size) return;
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  const user = '@' + localpart + ':' + tenant.server_name;
  const current = new Map((await publicDeviceKeys(conn, localpart) ?? [])
    .map((device) => [device.device_id, device]));
  for (const [deviceId, payload] of latest) {
    // Keyless creation/name notices do not retain public key material that can
    // resurrect. A later upload for this device replaces that source snapshot.
    if (!payload.keys && !payload.deleted) continue;
    const device = current.get(deviceId);
    const keys = device
      ? await signatureView(conn, JSON.parse(device.key_json), user, deviceId)
      : undefined;
    const matches = payload.deleted
      ? !device
      : device && canonicalJson(keys) === canonicalJson(payload.keys) &&
        (device.display_name ?? null) === (payload.device_display_name ?? null);
    if (matches) continue;
    const { pos, stream, wire } = await reserveDeviceChange(conn, localpart);
    if (!wire) {
      throw new Error('semantic device reset lost enrolled wire authority');
    }
    await retainDeviceChange(
      conn,
      { localpart, deviceId: '', generation: 0 },
      pos,
      stream,
      {
        kind: 'semantic_reset',
        device_id: '',
        deleted: true,
        wire,
      },
    );
    await recordTenantProjection(conn);
    return;
  }
}

async function reserveDeviceChange(conn: Conn, localpart: string) {
  const [prior] = await conn.query(
    'SELECT value FROM user_device_stream WHERE localpart=?',
    [localpart],
  );
  const wire = await allocateDeviceWire(
    conn,
    localpart,
    prior ? Number(prior.value) : 0,
  );
  await conn.execute(
    'INSERT INTO user_device_stream(localpart,value) VALUES(?,?) ON CONFLICT(localpart) DO UPDATE SET value=excluded.value',
    [localpart, wire ? wire.streamId : (prior ? Number(prior.value) : 0) + 1],
  );
  const [stream] = await conn.query(
    'SELECT value FROM user_device_stream WHERE localpart=?',
    [localpart],
  );
  return {
    pos: await nextCounter(conn, 'e2ee_changes'),
    stream: Number(stream.value),
    wire,
  };
}

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
      const allocated = await allocateDeviceWire(conn, localpart, floor - 1);
      const wire = allocated ? { ...allocated, prevIds: [] } : null;
      const stream = wire?.streamId ?? floor;
      await conn.execute(
        'INSERT INTO user_device_stream VALUES(?,?) ON CONFLICT(localpart) DO UPDATE SET value=excluded.value',
        [localpart, stream],
      );
      await retainDeviceChange(
        conn,
        { localpart, deviceId: '', generation: 0 },
        await nextCounter(conn, 'e2ee_changes'),
        stream,
        {
          kind: 'restore_reset',
          device_id: '',
          deleted: true,
          ...(wire ? { wire } : {}),
        },
      );
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
  signatureOperation?: SignatureOperation,
): Promise<void> {
  const rows = deleted ? [] : await conn.query(
    'SELECT d.display_name,k.key_json FROM devices d LEFT JOIN device_keys k ON k.localpart=d.localpart AND k.device_id=d.device_id AND k.generation=d.generation WHERE d.localpart=? AND d.device_id=? AND d.generation=?',
    [device.localpart, device.deviceId, device.generation],
  );
  const { pos, stream, wire } = await reserveDeviceChange(
    conn,
    device.localpart,
  );
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
  const operation = await deviceChangeOperation(
    conn,
    device,
    pos,
    deleted ? null : {
      displayName: rows[0].display_name === null
        ? null
        : String(rows[0].display_name),
      // Public overlays have their own exact-target/signer operations. Retain
      // original owner material here, not a projection that can become stale
      // when a cross-signing key or another device is replaced.
      keys: rows[0].key_json === null
        ? null
        : JSON.parse(String(rows[0].key_json)) as Json,
    },
    wire ?? undefined,
  );
  await retainDeviceChange(conn, device, pos, stream, {
    ...payload,
    ...(wire ? { wire } : {}),
    ...(operation ? { operation } : {}),
    ...(signatureOperation ? { signatureOperation } : {}),
  });
  await reconcileDevicePublications(conn, device.localpart);
}

/** Verified signatures change a public device view without acquiring the base
 * device's mutation/session/pool authority. Zero is a publication-only handle,
 * never a copied generation or an executable device identity. */
export async function appendDeviceOverlayChange(
  conn: Conn,
  localpart: string,
  deviceId: string,
  keys: Json,
  displayName: string | null,
  signatureOperation: SignatureOperation,
) {
  const { pos, stream, wire } = await reserveDeviceChange(conn, localpart);
  await retainDeviceChange(
    conn,
    { localpart, deviceId, generation: 0 },
    pos,
    stream,
    {
      device_id: deviceId,
      keys,
      ...(displayName === null ? {} : { device_display_name: displayName }),
      signatureOperation,
      ...(wire ? { wire } : {}),
    },
  );
  await reconcileDevicePublications(conn, localpart);
}

async function retainDeviceChange(
  conn: Conn,
  device: DeviceIdentity,
  pos: number,
  stream: number,
  payload: Record<string, unknown>,
) {
  const [tenant] = await conn.query('SELECT server_name FROM tenant');
  if (payload.wire) {
    const identity = await tenantAuthority(conn);
    if (!identity) throw new Error('device wire source authority missing');
    await retainDeviceWire(
      conn,
      device.localpart,
      (payload.operation as { operationId: string } | undefined)?.operationId ??
        canonicalJson([
          identity.node,
          identity.incarnation,
          'device-publication',
          pos,
        ]),
      identity.node,
      identity.incarnation,
      payload.wire as DeviceWire,
    );
  }
  const server = String(tenant.server_name);
  const {
    generation: _generation,
    operation: _operation,
    signatureOperation: _signatureOperation,
    wire: _wire,
    ...wire
  } = payload;
  void [_generation, _operation, _signatureOperation, _wire];
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
        prev_id: (payload.wire as DeviceWire | undefined)?.prevIds ??
          [Number.MAX_SAFE_INTEGER],
      },
    }])),
    config().federation.bulkmaxbytes,
  );
  await conn.execute('INSERT INTO e2ee_changes VALUES(?,?,?,?,?,?)', [
    pos,
    device.localpart,
    device.deviceId,
    device.generation,
    stream,
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
