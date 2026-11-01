import type { Database } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { membershipOf } from './read.ts';

export async function clearPurgeable(
  db: Database,
  roomId: string,
  userId: string,
) {
  await db.tx(async (tx) => {
    await tx.execute('DELETE FROM forgotten WHERE user = ? AND room = ?', [
      userId,
      roomId,
    ]);
    await tx.execute(
      'UPDATE directory SET purgeable_ms = NULL WHERE room_id = ?',
      [roomId],
    );
  });
}

export async function forget(
  db: Database,
  roomId: string,
  userId: string,
  self: string,
) {
  const current = await membershipOf(db, roomId, userId);
  if (current?.membership === 'join') {
    throw new MatrixError(
      400,
      'M_UNKNOWN',
      `User ${userId} is in room ${roomId}`,
    );
  }
  if (current === null) {
    throw new MatrixError(400, 'M_UNKNOWN', 'no membership to forget');
  }
  await db.tx(async (tx) => {
    await tx.execute(
      'INSERT INTO forgotten(user, room) VALUES(?,?) ON CONFLICT DO NOTHING',
      [userId, roomId],
    );
    const rows = await tx.query(
      `SELECT m.user FROM memberships m LEFT JOIN forgotten f ON f.user=m.user AND f.room=m.room WHERE m.room=? AND f.user IS NULL`,
      [roomId],
    );
    if (rows.every((row) => !String(row.user).endsWith(':' + self))) {
      await tx.execute(
        'INSERT INTO directory(room_id, purgeable_ms) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET purgeable_ms = COALESCE(directory.purgeable_ms, excluded.purgeable_ms)',
        [roomId, Date.now()],
      );
    }
  });
}
