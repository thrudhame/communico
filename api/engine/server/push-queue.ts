// Delivery intent and badges share the publication/read/removal transaction.
// Queue lifetime never determines notification counts or listing membership.
import type { Conn } from '#engine/store/db.ts';
import { visiblePrejoin, visibleRoomMembership } from './prejoin.ts';
import {
  insertPublicationRows,
  reservePublicationCounter,
} from './publication-rows.ts';

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

/** Ordered badge calls retain their exact revisions even when their writes
 * coalesce. No sender/maintenance owner can observe an intermediate tx state. */
export async function applyPublicationPushQueue(
  tx: Conn,
  badges: readonly { user: string; incarnation?: string }[],
  deliveries:
    readonly (readonly [string, number, string, string, string, number])[],
  now: number,
): Promise<void> {
  const users = [
    ...new Set(
      badges.filter((b) => b.incarnation === undefined).map((b) => b.user),
    ),
  ];
  const targets = users.length
    ? await tx.query(
      "SELECT t.user,t.incarnation FROM json_each(?) j JOIN push_targets t ON t.user=CAST(j.value AS TEXT) WHERE t.state='active'",
      [JSON.stringify(users)],
    )
    : [];
  const operations = badges.map((badge) => ({
    user: badge.user,
    targets: badge.incarnation === undefined
      ? targets.filter((t) => t.user === badge.user).map((t) =>
        String(t.incarnation)
      )
      : [badge.incarnation],
  })).filter((op) => op.targets.length);
  await insertPublicationRows(tx, 'push_delivery', [
    'incarnation',
    'notification_seq',
    'user',
    'room',
    'event',
    'created_ms',
    'state',
    'attempts',
    'next_ms',
  ], deliveries.map((d) => [...d, 'pending', 0, 0]));
  if (!operations.length) return;
  const first = await reservePublicationCounter(
    tx,
    'push_badges',
    operations.length,
  );
  const final = new Map<string, (string | number)[]>();
  for (let at = 0; at < operations.length; at++) {
    const op = operations[at];
    for (const incarnation of op.targets) {
      final.set(incarnation, [incarnation, op.user, first + at, 0, 0, 0, now]);
    }
  }
  await insertPublicationRows(
    tx,
    'push_badges',
    [
      'incarnation',
      'user',
      'revision',
      'sent_revision',
      'attempts',
      'next_ms',
      'created_ms',
    ],
    [...final.values()],
    `ON CONFLICT(incarnation) DO UPDATE SET
    created_ms=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN excluded.created_ms ELSE created_ms END,
    attempts=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN 0 ELSE attempts END,
    next_ms=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN 0 ELSE next_ms END,
    error=CASE WHEN revision<=MAX(sent_revision,expired_revision) THEN NULL ELSE error END,
    revision=excluded.revision`,
  );
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
