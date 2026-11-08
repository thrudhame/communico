// Opaque encrypted backup data is tenant-user truth, never room state.
import type { Conn } from '#engine/store/db.ts';
import type { Config } from '#engine/config-schema.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { nextCounter } from '#engine/tenant/accountdata.ts';
import { bounded, limitEntries, object } from '#engine/tenant/e2ee.ts';
import type { Json } from '#engine/tenant/e2ee.ts';

type Limits = Config['e2ee'];
export type Action = 'get' | 'put' | 'delete' | 'post';
type VersionRow = {
  version_no: number;
  algorithm: string;
  auth_data: string;
  etag: number;
  deleted: number;
};
type Session = {
  first_message_index: number;
  forwarded_count: number;
  is_verified: boolean;
  session_data: Json;
};
type Entry = { room: string; session: string; data: Session };
const missing = () =>
  new MatrixError(404, 'M_NOT_FOUND', 'Unknown backup version or key');
function invalid(message: string): never {
  throw new MatrixError(400, 'M_INVALID_PARAM', message);
}
function versionNumber(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw missing();
  }
  return Number(value);
}
async function versionRow(
  conn: Conn,
  user: string,
  version?: string,
): Promise<VersionRow> {
  const rows = version === undefined
    ? await conn.query(
      'SELECT version_no,algorithm,auth_data,etag,deleted FROM backup_versions WHERE localpart=? AND deleted=0 ORDER BY version_no DESC LIMIT 1',
      [user],
    )
    : await conn.query(
      'SELECT version_no,algorithm,auth_data,etag,deleted FROM backup_versions WHERE localpart=? AND version_no=?',
      [user, versionNumber(version)],
    );
  if (!rows.length) throw missing();
  const row = rows[0];
  return {
    version_no: Number(row.version_no),
    algorithm: String(row.algorithm),
    auth_data: String(row.auth_data),
    etag: Number(row.etag),
    deleted: Number(row.deleted),
  };
}
async function stats(conn: Conn, user: string, row: VersionRow) {
  const result = await conn.query(
    'SELECT COUNT(*) AS n FROM backup_sessions WHERE localpart=? AND version_no=?',
    [user, row.version_no],
  );
  return { count: Number(result[0].n), etag: String(row.etag) };
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
function backupOverflow(): never {
  throw new MatrixError(
    413,
    'M_TOO_LARGE',
    'Backup restore byte limit exceeded',
  );
}

// Measure the exact whole-backup JSON without loading or parsing ciphertext.
// This runs in the writing transaction, so every accepted set can be restored
// without depending on the much smaller individual upload request budget.
async function assertRestoreCapacity(
  conn: Conn,
  user: string,
  version: number,
  limits: Limits,
): Promise<void> {
  const rows = await conn.query(
    'SELECT room_id,session_id,length(CAST(payload AS BLOB)) AS payload_bytes FROM backup_sessions WHERE localpart=? AND version_no=? ORDER BY room_id,session_id LIMIT ?',
    [user, version, limits.maxbackupsessions + 1],
  );
  limitEntries(rows.length, limits.maxbackupsessions);
  let size = bytes('{"rooms":{}}');
  let previousRoom: string | undefined;
  for (const row of rows) {
    const room = String(row.room_id);
    if (room !== previousRoom) {
      size += bytes(JSON.stringify(room)) + bytes(':{"sessions":{}}') +
        (previousRoom === undefined ? 0 : 1);
    } else size++;
    size += bytes(JSON.stringify(String(row.session_id))) + 1 +
      Number(row.payload_bytes);
    if (size > limits.maxbackupbytes) backupOverflow();
    previousRoom = room;
  }
  if (size > limits.maxbackupbytes) backupOverflow();
}

export async function backupVersion(
  conn: Conn,
  user: string,
  action: Action,
  version: string | undefined,
  input: unknown,
  limits: Limits,
): Promise<Json> {
  if (action === 'post') {
    const body = metadata(input, limits);
    const active = await conn.query(
      'SELECT COUNT(*) AS n FROM backup_versions WHERE localpart=? AND deleted=0',
      [user],
    );
    limitEntries(Number(active[0].n) + 1, limits.maxbackupversions);
    const next = await nextCounter(conn, 'backup:' + user);
    if (!Number.isSafeInteger(next)) {
      throw new MatrixError(
        413,
        'M_TOO_LARGE',
        'Backup version space exhausted',
      );
    }
    await conn.execute(
      'INSERT INTO backup_versions(localpart,version_no,algorithm,auth_data,etag,deleted) VALUES(?,?,?,?,0,0)',
      [user, next, body.algorithm, JSON.stringify(body.auth_data)],
    );
    return { version: String(next) };
  }
  const row = await versionRow(conn, user, version);
  if (action === 'delete') {
    await conn.execute(
      'DELETE FROM backup_sessions WHERE localpart=? AND version_no=?',
      [user, row.version_no],
    );
    await conn.execute(
      "UPDATE backup_versions SET deleted=1,auth_data='{}' WHERE localpart=? AND version_no=?",
      [user, row.version_no],
    );
    return {};
  }
  if (row.deleted) throw missing();
  if (action === 'put') {
    const body = metadata(input, limits);
    if (
      body.algorithm !== row.algorithm ||
      (body.version !== undefined && body.version !== version)
    ) invalid('Backup algorithm or version does not match');
    await conn.execute(
      'UPDATE backup_versions SET auth_data=? WHERE localpart=? AND version_no=?',
      [JSON.stringify(body.auth_data), user, row.version_no],
    );
    return {};
  }
  const result = {
    version: String(row.version_no),
    algorithm: row.algorithm,
    auth_data: JSON.parse(row.auth_data),
    ...await stats(conn, user, row),
  };
  bounded(result, limits.maxbackupbytes);
  return result;
}
function metadata(
  input: unknown,
  limits: Limits,
): Json & { algorithm: string; auth_data: Json } {
  bounded(input, limits.maxrequestbytes);
  const body = object(input, 'backup metadata');
  if (typeof body.algorithm !== 'string' || !body.algorithm.length) {
    invalid('Backup algorithm required');
  }
  const auth = object(body.auth_data, 'auth_data');
  bounded(body, limits.maxkeybytes);
  bounded({
    version: String(Number.MAX_SAFE_INTEGER),
    algorithm: body.algorithm,
    auth_data: auth,
    count: Number.MAX_SAFE_INTEGER,
    etag: String(Number.MAX_SAFE_INTEGER),
  }, limits.maxbackupbytes);
  return { ...body, algorithm: body.algorithm, auth_data: auth };
}
function sessionData(input: unknown, limits: Limits): Session {
  const body = object(input, 'session');
  for (const field of ['first_message_index', 'forwarded_count']) {
    if (!Number.isSafeInteger(body[field]) || Number(body[field]) < 0) {
      invalid(field + ' must be a nonnegative integer');
    }
  }
  if (typeof body.is_verified !== 'boolean') {
    invalid('is_verified must be a boolean');
  }
  const result = {
    first_message_index: Number(body.first_message_index),
    forwarded_count: Number(body.forwarded_count),
    is_verified: body.is_verified,
    session_data: object(body.session_data, 'session_data'),
  };
  bounded(result, limits.maxkeybytes);
  return result;
}
function entries(
  input: unknown,
  room: string | undefined,
  session: string | undefined,
  limits: Limits,
): Entry[] {
  bounded(input, limits.maxrequestbytes);
  const result: Entry[] = [];
  const add = (r: string, s: string, value: unknown) => {
    if (!r.length || !s.length) {
      invalid('Room and session IDs must not be empty');
    }
    bounded([r, s], limits.maxkeybytes);
    limitEntries(result.length + 1, limits.maxkeys);
    result.push({ room: r, session: s, data: sessionData(value, limits) });
  };
  if (room !== undefined && session !== undefined) add(room, session, input);
  else {
    const rooms = room === undefined
      ? object(object(input, 'body').rooms, 'rooms')
      : { [room]: input };
    for (const [r, value] of Object.entries(rooms)) {
      for (
        const [s, data] of Object.entries(
          object(object(value, 'room').sessions, 'sessions'),
        )
      ) add(r, s, data);
    }
  }
  return result;
}
function better(next: Session, old: Session): boolean {
  if (next.is_verified !== old.is_verified) return next.is_verified;
  if (next.first_message_index !== old.first_message_index) {
    return next.first_message_index < old.first_message_index;
  }
  return next.forwarded_count < old.forwarded_count;
}
export async function backupKeys(
  conn: Conn,
  user: string,
  action: Action,
  version: string | null,
  room: string | undefined,
  session: string | undefined,
  input: unknown,
  limits: Limits,
): Promise<Json> {
  if (version === null) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'version is required');
  }
  const updates = action === 'put' ? entries(input, room, session, limits) : [];
  const row = await versionRow(conn, user, version);
  if (row.deleted) throw missing();
  const args = [
    user,
    row.version_no,
    ...(room === undefined ? [] : [room]),
    ...(session === undefined ? [] : [session]),
  ];
  const where = 'localpart=? AND version_no=?' +
    (room === undefined ? '' : ' AND room_id=?') +
    (session === undefined ? '' : ' AND session_id=?');
  let changed = false;
  if (action === 'put') {
    const current = await versionRow(conn, user);
    if (current.version_no !== row.version_no) {
      throw new MatrixError(
        403,
        'M_WRONG_ROOM_KEYS_VERSION',
        'Wrong backup version',
        {
          errcode: 'M_WRONG_ROOM_KEYS_VERSION',
          error: 'Wrong backup version',
          current_version: String(current.version_no),
        },
      );
    }
    for (const entry of updates) {
      const previous = await conn.query(
        'SELECT payload FROM backup_sessions WHERE localpart=? AND version_no=? AND room_id=? AND session_id=?',
        [user, row.version_no, entry.room, entry.session],
      );
      if (
        !previous.length ||
        better(entry.data, JSON.parse(String(previous[0].payload)))
      ) {
        await conn.execute(
          'INSERT INTO backup_sessions(localpart,version_no,room_id,session_id,payload) VALUES(?,?,?,?,?) ON CONFLICT(localpart,version_no,room_id,session_id) DO UPDATE SET payload=excluded.payload',
          [
            user,
            row.version_no,
            entry.room,
            entry.session,
            JSON.stringify(entry.data),
          ],
        );
        changed = true;
      }
    }
    const total = await conn.query(
      'SELECT COUNT(*) AS n FROM backup_sessions WHERE localpart=?',
      [user],
    );
    limitEntries(Number(total[0].n), limits.maxbackupsessions);
    await assertRestoreCapacity(conn, user, row.version_no, limits);
  } else if (action === 'delete') {
    const exists = await conn.query(
      'SELECT 1 FROM backup_sessions WHERE ' + where + ' LIMIT 1',
      args,
    );
    changed = exists.length > 0;
    if (changed) {
      await conn.execute('DELETE FROM backup_sessions WHERE ' + where, args);
    }
  } else {
    const rows = await conn.query(
      'SELECT room_id,session_id,payload FROM backup_sessions WHERE ' + where +
        ' ORDER BY room_id,session_id LIMIT ?',
      [...args, limits.maxbackupsessions + 1],
    );
    limitEntries(rows.length, limits.maxbackupsessions);
    if (session !== undefined) {
      if (!rows.length) throw missing();
      const result = JSON.parse(String(rows[0].payload));
      bounded(result, limits.maxbackupbytes);
      return result;
    }
    const rooms: Record<string, { sessions: Json }> = Object.create(null);
    for (const stored of rows) {
      const r = String(stored.room_id);
      const value = rooms[r] ??= { sessions: Object.create(null) };
      value.sessions[String(stored.session_id)] = JSON.parse(
        String(stored.payload),
      );
    }
    const result = room === undefined
      ? { rooms }
      : rooms[room] ?? { sessions: {} };
    bounded(result, limits.maxbackupbytes);
    return result;
  }
  if (changed) {
    row.etag++;
    if (!Number.isSafeInteger(row.etag)) {
      throw new MatrixError(
        413,
        'M_TOO_LARGE',
        'Backup revision space exhausted',
      );
    }
    await conn.execute(
      'UPDATE backup_versions SET etag=? WHERE localpart=? AND version_no=?',
      [row.etag, user, row.version_no],
    );
  }
  return await stats(conn, user, row);
}

export async function clearBackup(conn: Conn, user: string): Promise<void> {
  await conn.execute('DELETE FROM backup_sessions WHERE localpart=?', [user]);
  await conn.execute(
    "UPDATE backup_versions SET deleted=1,auth_data='{}' WHERE localpart=?",
    [user],
  );
}
