import type { Database } from '#engine/store/db.ts';
export async function purgeable(db: Database, roomId: string) {
  return (await db.query(
    'SELECT 1 FROM directory WHERE room_id = ? AND purgeable_ms IS NOT NULL',
    [roomId],
  )).length > 0;
}
export async function visibility(
  db: Database,
  roomId: string,
): Promise<string> {
  const rows = await db.query(
    'SELECT visibility FROM visibility WHERE room_id = ?',
    [roomId],
  );
  return rows.length === 0 ? 'private' : String(rows[0].visibility);
}
export async function setVisibility(
  db: Database,
  roomId: string,
  value: string,
) {
  await db.execute(
    'INSERT INTO visibility(room_id,visibility) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET visibility=excluded.visibility',
    [roomId, value],
  );
}
export async function listedRooms(db: Database) {
  return (await db.query(
    "SELECT v.room_id FROM visibility v LEFT JOIN directory d ON d.room_id=v.room_id WHERE v.visibility='public' AND d.purgeable_ms IS NULL ORDER BY v.room_id",
  )).map((r) => String(r.room_id));
}
export async function allMemberRooms(db: Database) {
  return (await db.query('SELECT DISTINCT room FROM memberships ORDER BY room'))
    .map((r) => String(r.room));
}
export async function joinedUsers(db: Database, roomId: string) {
  return (await db.query(
    "SELECT user FROM memberships WHERE room=? AND membership='join' ORDER BY user",
    [roomId],
  )).map((r) => String(r.user));
}
