import { lookupRoom } from '#engine/room.ts';
import { serverDb, ident, withDb } from '#engine/db.ts';

// Newest extremity's wire event_id: newest-tipped x* branch in the room
// DB -> its tip hash -> event_index (D8: branch tip == event commit).
export async function latestExtremityEventId(roomId: string): Promise<string> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  return await withDb(room.dbName, async (c) => {
    const b = await c.query(
      `SELECT name FROM dolt.branches WHERE name LIKE 'x%'
       ORDER BY latest_commit_date DESC, name ASC LIMIT 1;`,
    );
    if (b.rows.length === 0) throw new Error('no extremity branches');
    const branch = String(b.rows[0].name);
    const h = await c.query(
      `SELECT (SELECT HASHOF('${ident(branch)}')) AS h;`,
    );
    const tipHash = String(h.rows[0].h);
    return await withDb(serverDb(), async (s) => {
      const r = await s.query(
        'SELECT event_id FROM event_index WHERE room_id = $1 AND commit_hash = $2;',
        [roomId, tipHash],
      );
      if (r.rows.length === 0) throw new Error('tip not in event_index');
      return String(r.rows[0].event_id);
    });
  });
}

// Drops the room DB + server rows so content-addressed test rooms can be
// re-created on reruns.
export async function resetRoom(roomId: string): Promise<void> {
  const { dbNameFor } = await import('#engine/room.ts');
  const dbName = await dbNameFor(roomId);
  await withDb(serverDb(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${dbName};`);
    await c.query('DELETE FROM room_directory WHERE room_id = $1;', [roomId]);
    await c.query('DELETE FROM event_index WHERE room_id = $1;', [roomId]);
  });
}
