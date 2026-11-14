// Issued connection snapshots are tenant/device state, never room truth or inbox ack.
import type { Conn } from '#engine/store/db.ts';
import type { DeviceIdentity } from './devices.ts';
import { current } from './e2ee.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Config } from '#engine/config.ts';

type Limits = Config['slidingsync'];
export type PositionLease = {
  connection: string;
  revision: number;
  position: string | null;
  state: Record<string, unknown> | null;
  replaces?: { connection: string; revision: number; name: string };
};
const scope = (d: DeviceIdentity) => [d.localpart, d.deviceId, d.generation];
function unknown(): never {
  throw new MatrixError(400, 'M_UNKNOWN_POS', 'unknown sliding sync position');
}

export async function resetRestoredPositions(conn: Conn): Promise<{
  slidingPositions: number;
  slidingConnections: number;
}> {
  const slidingPositions = await conn.execute(
    'DELETE FROM sliding_sync_positions',
  );
  const slidingConnections = await conn.execute(
    'DELETE FROM sliding_sync_connections',
  );
  return { slidingPositions, slidingConnections };
}
export async function prunePositions(conn: Conn, now: number): Promise<void> {
  await conn.execute(
    'DELETE FROM sliding_sync_positions WHERE connection_id IN (SELECT id FROM sliding_sync_connections WHERE expires_ms<=?)',
    [now],
  );
  await conn.execute(
    'DELETE FROM sliding_sync_connections WHERE expires_ms<=?',
    [now],
  );
}
export async function beginPosition(
  conn: Conn,
  d: DeviceIdentity,
  name: string,
  position: string | null,
  limits: Limits,
  now: number,
): Promise<PositionLease> {
  await current(conn, d);
  if (name.length > 64) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid conn_id');
  }
  const rows = await conn.query(
    'SELECT id,revision,expires_ms FROM sliding_sync_connections WHERE localpart=? AND device_id=? AND generation=? AND conn_id=?',
    [...scope(d), name],
  );
  const row = rows[0];
  if (position !== null) {
    if (!row || Number(row.expires_ms) <= now) unknown();
    const snapshots = await conn.query(
      'SELECT state_json FROM sliding_sync_positions WHERE token=? AND connection_id=?',
      [position, row.id],
    );
    if (!snapshots.length) unknown();
    const revision = Number(row.revision) + 1;
    await conn.execute(
      'UPDATE sliding_sync_connections SET revision=? WHERE id=?',
      [revision, row.id],
    );
    return {
      connection: String(row.id),
      revision,
      position,
      state: JSON.parse(String(snapshots[0].state_json)),
    };
  }
  await prunePositions(conn, now);
  if (row && Number(row.expires_ms) > now) {
    const revision = Number(row.revision) + 1;
    await conn.execute(
      'UPDATE sliding_sync_connections SET revision=? WHERE id=?',
      [revision, row.id],
    );
    // Keep the issued response usable until the replacement commits. Its fresh
    // ID also fences inbox receipts from the prior connection incarnation.
    return {
      connection: crypto.randomUUID(),
      revision: 0,
      position: null,
      state: null,
      replaces: { connection: String(row.id), revision, name },
    };
  }
  const total = await conn.query(
    'SELECT COUNT(*) AS n FROM sliding_sync_connections',
  );
  const own = await conn.query(
    'SELECT COUNT(*) AS n FROM sliding_sync_connections WHERE localpart=? AND device_id=? AND generation=?',
    scope(d),
  );
  if (
    Number(total[0].n) >= limits.maxconnections ||
    Number(own[0].n) >= limits.maxconnectionsperdevice
  ) {
    throw new MatrixError(
      429,
      'M_LIMIT_EXCEEDED',
      'sliding sync connection capacity reached',
    );
  }
  const id = crypto.randomUUID();
  await conn.execute(
    'INSERT INTO sliding_sync_connections VALUES(?,?,?,?,?,?,?)',
    [id, ...scope(d), name, 0, now + limits.connectionseconds * 1000],
  );
  return { connection: id, revision: 0, position: null, state: null };
}
export async function commitPosition(
  conn: Conn,
  d: DeviceIdentity,
  lease: PositionLease,
  state: Record<string, unknown>,
  limits: Limits,
  now: number,
): Promise<string> {
  await current(conn, d);
  const rows = await conn.query(
    'SELECT revision,expires_ms FROM sliding_sync_connections WHERE id=? AND localpart=? AND device_id=? AND generation=?',
    [lease.replaces?.connection ?? lease.connection, ...scope(d)],
  );
  if (
    !rows.length ||
    Number(rows[0].revision) !== (lease.replaces?.revision ?? lease.revision) ||
    Number(rows[0].expires_ms) <= now
  ) unknown();
  if (
    lease.position !== null &&
    !(await conn.query(
      'SELECT 1 FROM sliding_sync_positions WHERE token=? AND connection_id=?',
      [lease.position, lease.connection],
    )).length
  ) unknown();
  const json = JSON.stringify(state);
  if (new TextEncoder().encode(json).length > limits.maxsnapshotbytes) {
    unknown();
  }
  if (lease.replaces) {
    await conn.execute(
      'DELETE FROM sliding_sync_positions WHERE connection_id=?',
      [lease.replaces.connection],
    );
    await conn.execute('DELETE FROM sliding_sync_connections WHERE id=?', [
      lease.replaces.connection,
    ]);
    await conn.execute(
      'INSERT INTO sliding_sync_connections VALUES(?,?,?,?,?,?,?)',
      [
        lease.connection,
        ...scope(d),
        lease.replaces.name,
        0,
        now + limits.connectionseconds * 1000,
      ],
    );
  }
  // Only a completed response retires old input/forks. Begin/cancel/failed render
  // cannot consume unseen data, and an in-flight older lease cannot publish.
  if (lease.position === null) {
    await conn.execute(
      'DELETE FROM sliding_sync_positions WHERE connection_id=?',
      [lease.connection],
    );
  } else {
    await conn.execute(
      'DELETE FROM sliding_sync_positions WHERE connection_id=? AND token!=?',
      [lease.connection, lease.position],
    );
  }
  const token = crypto.randomUUID();
  await conn.execute('INSERT INTO sliding_sync_positions VALUES(?,?,?)', [
    token,
    lease.connection,
    json,
  ]);
  await conn.execute(
    'UPDATE sliding_sync_connections SET revision=revision+1,expires_ms=? WHERE id=?',
    [now + limits.connectionseconds * 1000, lease.connection],
  );
  return token;
}
