// Exact JSON restore size, maintained with ciphertext in the tenant transaction.
// Room aggregates let room/version deletion avoid hydrating individual sessions.
import type { Conn } from '#engine/store/db.ts';

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).byteLength;
export const EMPTY_BACKUP_BYTES = bytes('{"rooms":{}}');
const roomBytes = (room: string) =>
  bytes(JSON.stringify(room)) + bytes(':{"sessions":{}}');
const entryBytes = (session: string, payload: string) =>
  bytes(JSON.stringify(session)) + 1 + bytes(payload);

export const BACKUP_ACCOUNTING_SQL = `
ALTER TABLE backup_versions ADD COLUMN session_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE backup_versions ADD COLUMN restore_bytes INTEGER NOT NULL DEFAULT ${EMPTY_BACKUP_BYTES};
CREATE TABLE backup_rooms(localpart TEXT NOT NULL,version_no INTEGER NOT NULL,room_id TEXT NOT NULL,session_count INTEGER NOT NULL,entry_bytes INTEGER NOT NULL,PRIMARY KEY(localpart,version_no,room_id));
`;

export async function accountSession(
  conn: Conn,
  user: string,
  version: number,
  room: string,
  session: string,
  payload: string,
  previous?: string,
): Promise<void> {
  const args = [user, version, room];
  const [aggregate] = await conn.query(
    'SELECT session_count FROM backup_rooms WHERE localpart=? AND version_no=? AND room_id=?',
    args,
  );
  const count = aggregate ? Number(aggregate.session_count) : 0;
  const added = previous === undefined ? 1 : 0;
  const delta = entryBytes(session, payload) -
    (previous === undefined ? 0 : entryBytes(session, previous));
  let restoreDelta = delta + (added && count > 0 ? 1 : 0);
  if (!count) {
    const [total] = await conn.query(
      'SELECT session_count FROM backup_versions WHERE localpart=? AND version_no=?',
      [user, version],
    );
    restoreDelta += roomBytes(room) + (Number(total.session_count) > 0 ? 1 : 0);
  }
  await conn.execute(
    'INSERT INTO backup_rooms(localpart,version_no,room_id,session_count,entry_bytes) VALUES(?,?,?,?,?) ON CONFLICT(localpart,version_no,room_id) DO UPDATE SET session_count=session_count+?,entry_bytes=entry_bytes+?',
    [...args, added, delta, added, delta],
  );
  await conn.execute(
    'UPDATE backup_versions SET session_count=session_count+?,restore_bytes=restore_bytes+? WHERE localpart=? AND version_no=?',
    [added, restoreDelta, user, version],
  );
}

export async function forgetBackupEntries(
  conn: Conn,
  user: string,
  version: number,
  room?: string,
  session?: string,
): Promise<boolean> {
  const args = [user, version];
  const [total] = await conn.query(
    'SELECT session_count FROM backup_versions WHERE localpart=? AND version_no=?',
    args,
  );
  if (room === undefined) {
    if (!Number(total.session_count)) return false;
    await conn.execute(
      'DELETE FROM backup_sessions WHERE localpart=? AND version_no=?',
      args,
    );
    await conn.execute(
      'DELETE FROM backup_rooms WHERE localpart=? AND version_no=?',
      args,
    );
    await conn.execute(
      'UPDATE backup_versions SET session_count=0,restore_bytes=? WHERE localpart=? AND version_no=?',
      [EMPTY_BACKUP_BYTES, ...args],
    );
    return true;
  }
  const roomArgs = [...args, room];
  const [aggregate] = await conn.query(
    'SELECT session_count,entry_bytes FROM backup_rooms WHERE localpart=? AND version_no=? AND room_id=?',
    roomArgs,
  );
  if (!aggregate) return false;
  const count = Number(aggregate.session_count);
  let removed = count;
  let size = roomBytes(room) + Number(aggregate.entry_bytes) + count - 1;
  if (session !== undefined) {
    const [old] = await conn.query(
      'SELECT length(CAST(payload AS BLOB)) AS payload_bytes FROM backup_sessions WHERE localpart=? AND version_no=? AND room_id=? AND session_id=?',
      [...roomArgs, session],
    );
    if (!old) return false;
    removed = 1;
    if (count > 1) {
      const entry = bytes(JSON.stringify(session)) + 1 +
        Number(old.payload_bytes);
      size = entry + 1;
      await conn.execute(
        'UPDATE backup_rooms SET session_count=session_count-1,entry_bytes=entry_bytes-? WHERE localpart=? AND version_no=? AND room_id=?',
        [entry, ...roomArgs],
      );
    }
    await conn.execute(
      'DELETE FROM backup_sessions WHERE localpart=? AND version_no=? AND room_id=? AND session_id=?',
      [...roomArgs, session],
    );
  } else {
    await conn.execute(
      'DELETE FROM backup_sessions WHERE localpart=? AND version_no=? AND room_id=?',
      roomArgs,
    );
  }
  if (removed === count) {
    await conn.execute(
      'DELETE FROM backup_rooms WHERE localpart=? AND version_no=? AND room_id=?',
      roomArgs,
    );
    if (Number(total.session_count) > removed) size++;
  }
  await conn.execute(
    'UPDATE backup_versions SET session_count=session_count-?,restore_bytes=restore_bytes-? WHERE localpart=? AND version_no=?',
    [removed, size, ...args],
  );
  return true;
}

export async function migrateBackupAccounting(conn: Conn): Promise<void> {
  await conn.exec(BACKUP_ACCOUNTING_SQL);
  let cursor: (string | number)[] | undefined;
  while (true) {
    const rows = await conn.query(
      'SELECT localpart,version_no,room_id,session_id,payload FROM backup_sessions' +
        (cursor
          ? ' WHERE (localpart,version_no,room_id,session_id)>(?,?,?,?)'
          : '') +
        ' ORDER BY localpart,version_no,room_id,session_id LIMIT 256',
      cursor ?? [],
    );
    if (!rows.length) break;
    for (const row of rows) {
      await accountSession(
        conn,
        String(row.localpart),
        Number(row.version_no),
        String(row.room_id),
        String(row.session_id),
        String(row.payload),
      );
    }
    const last = rows.at(-1)!;
    cursor = [
      String(last.localpart),
      Number(last.version_no),
      String(last.room_id),
      String(last.session_id),
    ];
  }
}
