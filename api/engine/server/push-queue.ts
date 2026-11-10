// Delivery intent and badges share the publication/read/removal transaction.
// Queue lifetime never determines notification counts or listing membership.
import type { Conn } from '#engine/store/db.ts';
import { visiblePrejoin, visibleRoomMembership } from './prejoin.ts';

async function revision(tx: Conn): Promise<number> {
  await tx.execute(
    "INSERT INTO counters(name,value) VALUES('push_badges',0) ON CONFLICT DO NOTHING",
  );
  await tx.execute(
    "UPDATE counters SET value=value+1 WHERE name='push_badges'",
  );
  return Number(
    (await tx.query("SELECT value FROM counters WHERE name='push_badges'"))[0]
      .value,
  );
}

export async function queueBadge(
  tx: Conn,
  user: string,
  incarnation?: string,
): Promise<void> {
  const targets = incarnation === undefined
    ? await tx.query(
      "SELECT incarnation FROM push_targets WHERE user=? AND state='active'",
      [user],
    )
    : [{ incarnation }];
  if (!targets.length) return;
  const rev = await revision(tx);
  for (const target of targets) {
    await tx.execute(
      `INSERT INTO push_badges(incarnation,user,revision,sent_revision,attempts,next_ms,created_ms) VALUES(?,?,?,0,0,0,?) ON CONFLICT(incarnation) DO UPDATE SET
      created_ms=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN excluded.created_ms ELSE created_ms END,
      attempts=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN 0 ELSE attempts END,
      next_ms=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN 0 ELSE next_ms END,
      error=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN NULL ELSE error END,
      revision=excluded.revision`,
      [String(target.incarnation), user, rev, Date.now()],
    );
  }
}

export async function enqueuePush(
  tx: Conn,
  incarnation: string,
  seq: number,
  user: string,
  room: string,
  event: string,
  now: number,
): Promise<void> {
  await tx.execute(
    "INSERT INTO push_delivery(incarnation,notification_seq,user,room,event,created_ms,state,attempts,next_ms) VALUES(?,?,?,?,?,?,'pending',0,0) ON CONFLICT DO NOTHING",
    [incarnation, seq, user, room, event, now],
  );
  await queueBadge(tx, user, incarnation);
}

export async function cancelPushTarget(
  tx: Conn,
  incarnation: string,
): Promise<void> {
  await tx.execute(
    "UPDATE push_delivery SET state='cancelled' WHERE incarnation=? AND state='pending'",
    [incarnation],
  );
  await tx.execute('DELETE FROM push_badges WHERE incarnation=?', [
    incarnation,
  ]);
}

/** Joined-room notification totals include every thread. Invites contribute once
 * per pending invited room, independently of rule matches, without OOB/held dupes. */
export async function badgeCount(tx: Conn, user: string): Promise<number> {
  const joined = (await tx.query(
    `SELECT COALESCE(SUM(n.unread),0) AS n FROM notification_counts n JOIN memberships m ON m.user=n.user AND m.room=n.room WHERE n.user=? AND m.membership='join' AND ${
      visibleRoomMembership('m')
    }`,
    [user],
  ))[0];
  const invites = (await tx.query(
    `SELECT COUNT(*) AS n FROM (SELECT room FROM memberships m WHERE user=? AND membership='invite' AND ${
      visibleRoomMembership('m')
    } UNION SELECT room_id FROM prejoin_memberships p WHERE user_id=? AND status='pending' AND kind='invite' AND ${
      visiblePrejoin('p')
    })`,
    [user, user],
  ))[0];
  return Number(joined.n) + Number(invites.n);
}

export async function removePushWork(
  tx: Conn,
  scope: { room: string } | { user: string },
): Promise<void> {
  const column = 'room' in scope ? 'room' : 'user';
  const value = 'room' in scope ? scope.room : scope.user;
  const users = await tx.query(
    `SELECT DISTINCT user FROM notification_counts WHERE ${column}=?`,
    [value],
  );
  await tx.execute(
    `UPDATE push_delivery SET state='cancelled' WHERE ${column}=? AND state='pending'`,
    [value],
  );
  if ('user' in scope) {
    await tx.execute('DELETE FROM push_badges WHERE user=?', [value]);
    await tx.execute('DELETE FROM push_targets WHERE user=?', [value]);
  } else for (const row of users) await queueBadge(tx, String(row.user));
}
