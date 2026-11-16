// File-local wire identity owner. Signed control assigns lanes; tenant source
// positions remain local publication cursors and never become causal order.
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn } from '#engine/store/db.ts';
import type { OwnerControl } from '#engine/facade/ownership.ts';
import { tenantAuthority } from '#engine/tenant/session-authority.ts';
import { KeyHistoryProof } from '#engine/tenant/key-bootstrap.ts';
import type { DeviceOperation } from '#engine/tenant/device-source.ts';
import type { Json } from '#engine/tenant/e2ee.ts';

export type DeviceWire = { streamId: number; prevIds: number[] };

/** Exact publication evidence, independent of device execution authority. Some
 * publications only join a signature overlay or a complete snapshot frontier. */
export type DevicePublication = {
  version: 1;
  operationId: string;
  source: string;
  incarnation: string;
  localpart: string;
  wire: DeviceWire;
  payloadHash: string;
};

export async function captureDevicePublications(
  conn: Conn,
  localpart: string,
): Promise<DevicePublication[]> {
  return (await conn.query(
    'SELECT operation_id,source,incarnation,wire_json FROM device_stream_publications WHERE localpart=? ORDER BY operation_id',
    [localpart],
  )).map((row) => {
    const body = {
      version: 1 as const,
      operationId: String(row.operation_id),
      source: String(row.source),
      incarnation: String(row.incarnation),
      localpart,
      wire: deviceWireOf(JSON.parse(String(row.wire_json))),
    };
    return {
      ...body,
      payloadHash: createHash('sha256').update(canonicalJson(body)).digest(
        'hex',
      ),
    };
  });
}

export async function importDevicePublication(
  conn: Conn,
  raw: unknown,
  expected: { source: string; incarnation: string; localpart: string },
  proof?: KeyHistoryProof,
): Promise<void> {
  const operation = raw as DevicePublication | undefined;
  if (
    !operation || operation.version !== 1 ||
    typeof operation.operationId !== 'string' || !operation.operationId ||
    operation.source !== expected.source ||
    operation.incarnation !== expected.incarnation ||
    operation.localpart !== expected.localpart
  ) collision();
  const body = {
    version: 1 as const,
    operationId: operation.operationId,
    ...expected,
    wire: deviceWireOf(operation.wire),
  };
  if (
    canonicalJson({
      ...body,
      payloadHash: createHash('sha256').update(canonicalJson(body)).digest(
        'hex',
      ),
    }) !== canonicalJson(raw)
  ) collision();
  if (proof) await proof.require(conn, 'device-publication', operation);
  await retainDeviceWire(
    conn,
    operation.localpart,
    operation.operationId,
    operation.source,
    operation.incarnation,
    operation.wire,
    proof ? { proof, operation, kind: 'device-publication' } : undefined,
  );
}

export const DEVICE_STREAM_SQL = `
CREATE TABLE device_stream_publications(localpart TEXT NOT NULL,stream_id INTEGER NOT NULL,operation_id TEXT NOT NULL,source TEXT NOT NULL,incarnation TEXT NOT NULL,wire_json TEXT NOT NULL,PRIMARY KEY(localpart,stream_id),UNIQUE(localpart,operation_id));
CREATE TABLE device_stream_predecessors(localpart TEXT NOT NULL,stream_id INTEGER NOT NULL,previous_id INTEGER NOT NULL,PRIMARY KEY(localpart,stream_id,previous_id));
CREATE INDEX device_stream_descendants ON device_stream_predecessors(localpart,previous_id);
CREATE TABLE device_stream_frontier(localpart TEXT NOT NULL,stream_id INTEGER NOT NULL,PRIMARY KEY(localpart,stream_id));
CREATE TABLE device_stream_baselines(localpart TEXT PRIMARY KEY NOT NULL,floor INTEGER NOT NULL);
`;

export const DEVICE_CHECKPOINT_SQL = `
CREATE TABLE device_stream_checkpoints(localpart TEXT NOT NULL,stream_id INTEGER NOT NULL,frontier_json TEXT NOT NULL,snapshot_json TEXT NOT NULL,PRIMARY KEY(localpart,stream_id));
`;

/** Name a complete public view, not the numeric maximum of independent deltas.
 * The caller renders on this same owner connection. Checkpoint allocation,
 * exact response retention and frontier join commit or roll back together. */
export async function checkpointDeviceSnapshot(
  conn: Conn,
  localpart: string,
  snapshot: Json,
): Promise<Json> {
  const wire = await allocateDeviceWire(
    conn,
    localpart,
    Number(snapshot.stream_id),
  );
  if (!wire) return snapshot;
  if (wire.prevIds.length === 1) {
    const [held] = await conn.query(
      'SELECT snapshot_json FROM device_stream_checkpoints WHERE localpart=? AND stream_id=?',
      [localpart, wire.prevIds[0]],
    );
    if (held) {
      const previous = JSON.parse(String(held.snapshot_json)) as Json;
      if (
        canonicalJson({ ...previous, stream_id: 0 }) ===
          canonicalJson({ ...snapshot, stream_id: 0 })
      ) {
        return previous;
      }
    }
  }
  const identity = await tenantAuthority(conn);
  if (!identity) throw new Error('device checkpoint lost authority');
  const complete = { ...snapshot, stream_id: wire.streamId };
  await retainDeviceWire(
    conn,
    localpart,
    canonicalJson([
      'device-checkpoint',
      identity.node,
      identity.incarnation,
      localpart,
      wire.streamId,
    ]),
    identity.node,
    identity.incarnation,
    wire,
  );
  await conn.execute('INSERT INTO device_stream_checkpoints VALUES(?,?,?,?)', [
    localpart,
    wire.streamId,
    canonicalJson(wire.prevIds),
    canonicalJson(complete),
  ]);
  await conn.execute(
    'INSERT INTO user_device_stream VALUES(?,?) ON CONFLICT(localpart) DO UPDATE SET value=excluded.value',
    [localpart, wire.streamId],
  );
  return complete;
}

function collision(): never {
  throw new MatrixError(409, 'M_UNKNOWN', 'device wire publication collision');
}

export function deviceWireOf(raw: unknown): DeviceWire {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) collision();
  const row = raw as Record<string, unknown>;
  if (
    !Number.isSafeInteger(row.streamId) || Number(row.streamId) < 1 ||
    !Array.isArray(row.prevIds) ||
    new Set(row.prevIds).size !== row.prevIds.length ||
    row.prevIds.some((id) =>
      !Number.isSafeInteger(id) || id < 0 || id === row.streamId
    )
  ) collision();
  const wire = {
    streamId: Number(row.streamId),
    prevIds: row.prevIds as number[],
  };
  if (canonicalJson(wire) !== canonicalJson(raw)) collision();
  return wire;
}

async function controls(conn: Conn, active: boolean): Promise<OwnerControl[]> {
  const rows = await conn.query(
    active
      ? 'SELECT c.signed_json,c.body_hash,a.body_hash AS active_hash FROM facade_owner_activation a LEFT JOIN facade_owner_controls c ON a.pairing=c.pairing AND a.revision=c.revision'
      : 'SELECT signed_json FROM facade_owner_controls',
  );
  if (
    active &&
    rows.some((row) => !row.signed_json || row.body_hash !== row.active_hash)
  ) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'device stream awaits ownership control',
    );
  }
  return rows.map((row) =>
    JSON.parse(String(row.signed_json)).body as OwnerControl
  );
}

/** Unenrolled standalone/F1 changes keep their old serial contract. A lane is
 * usable only from installed, authenticated home control for this incarnation. */
export async function allocateDeviceWire(
  conn: Conn,
  localpart: string,
  previous: number,
): Promise<DeviceWire | null> {
  const identity = await tenantAuthority(conn);
  if (!identity) return null;
  const installed = await controls(conn, true);
  if (!installed.length) return null;
  const lanes = installed.flatMap((control) =>
    control.nodes.filter((node) =>
      node.node === identity.node && node.incarnation === identity.incarnation
    ).map((node) => node.lane)
  );
  if (
    !lanes.length ||
    lanes.some((lane) => canonicalJson(lane) !== canonicalJson(lanes[0]))
  ) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'device stream awaits ownership control',
    );
  }
  const { offset, stride } = lanes[0];
  const [baseline] = await conn.query(
    'SELECT floor FROM device_stream_baselines WHERE localpart=?',
    [localpart],
  );
  if (identity.node !== 'home' && !baseline) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'device stream awaits home allocation baseline',
    );
  }
  const after = Math.max(previous, baseline ? Number(baseline.floor) : 0);
  const streamId = after < offset
    ? offset
    : offset + (Math.floor((after - offset) / stride) + 1) * stride;
  if (!Number.isSafeInteger(streamId) || streamId <= after) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'device stream exhausted');
  }
  const prevIds = (await conn.query(
    'SELECT stream_id FROM device_stream_frontier WHERE localpart=? ORDER BY stream_id',
    [localpart],
  )).map((row) => Number(row.stream_id));
  return { streamId, prevIds };
}

/** Home captures this once, after its source has entered the signed odd lane.
 * Later home publications cannot introduce an old even serial identity. The
 * signed account bootstrap transports the floor before the first facade login;
 * it is allocator knowledge only, never a causal/received/applied checkpoint. */
export async function captureDeviceStreamFloor(
  conn: Conn,
  localpart: string,
): Promise<number | undefined> {
  const identity = await tenantAuthority(conn);
  if (
    !identity || identity.node !== 'home' ||
    !(await controls(conn, true)).length
  ) return undefined;
  const [held] = await conn.query(
    'SELECT floor FROM device_stream_baselines WHERE localpart=?',
    [localpart],
  );
  if (held) return Number(held.floor);
  const [stream] = await conn.query(
    'SELECT value FROM user_device_stream WHERE localpart=?',
    [localpart],
  );
  const floor = stream ? Number(stream.value) : 0;
  await installDeviceStreamFloor(conn, localpart, floor);
  return floor;
}

/** The account owner calls only after authenticating its complete home cut. */
export async function installDeviceStreamFloor(
  conn: Conn,
  localpart: string,
  floor: number,
): Promise<void> {
  if (!Number.isSafeInteger(floor) || floor < 0) collision();
  await conn.execute(
    'INSERT INTO device_stream_baselines VALUES(?,?) ON CONFLICT(localpart) DO UPDATE SET floor=MAX(device_stream_baselines.floor,excluded.floor)',
    [localpart, floor],
  );
}

/** Called with an immutable source fact or an authenticated imported fact in
 * its owning transaction. Retained historical controls validate original lanes
 * without making a retired incarnation current execution authority. */
export async function retainDeviceWire(
  conn: Conn,
  localpart: string,
  operationId: string,
  source: string,
  incarnation: string,
  raw: DeviceWire,
  history?:
    | {
      proof: KeyHistoryProof;
      operation: DeviceOperation;
      kind?: 'device-operation';
    }
    | {
      proof: KeyHistoryProof;
      operation: DevicePublication;
      kind: 'device-publication';
    },
): Promise<void> {
  const wire = deviceWireOf(raw);
  const installed = await controls(conn, false);
  let lanes = installed.flatMap((control) =>
    control.nodes.filter((node) =>
      node.node === source && node.incarnation === incarnation
    )
      .map((node) => node.lane)
  );
  if (!lanes.length && history) {
    if (
      !(history.proof instanceof KeyHistoryProof) ||
      history.operation.operationId !== operationId ||
      history.operation.localpart !== localpart ||
      history.operation.source !== source ||
      history.operation.incarnation !== incarnation ||
      canonicalJson(history.operation.wire) !== canonicalJson(wire)
    ) collision();
    await history.proof.require(
      conn,
      history.kind ?? 'device-operation',
      history.operation,
    );
    // A fresh receiver need not hold the retired pairing's control. Home's
    // exact-history signature attests that original source. F2's signed control
    // fixes the same role lanes for every incarnation; this is not a new grant.
    lanes = installed.map((control) =>
      control.nodes[source === 'home' ? 0 : 1].lane
    );
  }
  if (
    !lanes.length ||
    lanes.some(({ offset, stride }) =>
      wire.streamId < offset || (wire.streamId - offset) % stride !== 0
    )
  ) collision();
  const encoded = canonicalJson(wire);
  const prior = await conn.query(
    'SELECT stream_id,operation_id,source,incarnation,wire_json FROM device_stream_publications WHERE localpart=? AND (stream_id=? OR operation_id=?)',
    [localpart, wire.streamId, operationId],
  );
  if (prior.length) {
    if (
      prior.length !== 1 || Number(prior[0].stream_id) !== wire.streamId ||
      prior[0].operation_id !== operationId || prior[0].source !== source ||
      prior[0].incarnation !== incarnation || prior[0].wire_json !== encoded
    ) collision();
    return;
  }
  // A new, never-referenced identity cannot close a cycle. The uncommon
  // out-of-order case checks its actual ancestry, not numeric ID ordering.
  const referenced = (await conn.query(
    'SELECT 1 FROM device_stream_predecessors WHERE localpart=? AND previous_id=? LIMIT 1',
    [localpart, wire.streamId],
  )).length > 0;
  if (referenced) {
    for (const previous of wire.prevIds) {
      const cycle = await conn.query(
        'WITH RECURSIVE ancestors(id) AS (SELECT ? UNION SELECT p.previous_id FROM device_stream_predecessors p JOIN ancestors a ON p.stream_id=a.id WHERE p.localpart=?) SELECT 1 FROM ancestors WHERE id=? LIMIT 1',
        [previous, localpart, wire.streamId],
      );
      if (cycle.length) collision();
    }
  }
  await conn.execute(
    'INSERT INTO device_stream_publications VALUES(?,?,?,?,?,?)',
    [localpart, wire.streamId, operationId, source, incarnation, encoded],
  );
  for (const previous of wire.prevIds) {
    await conn.execute('INSERT INTO device_stream_predecessors VALUES(?,?,?)', [
      localpart,
      wire.streamId,
      previous,
    ]);
    await conn.execute(
      'DELETE FROM device_stream_frontier WHERE localpart=? AND stream_id=?',
      [localpart, previous],
    );
  }
  if (!referenced) {
    await conn.execute('INSERT INTO device_stream_frontier VALUES(?,?)', [
      localpart,
      wire.streamId,
    ]);
  }
}
