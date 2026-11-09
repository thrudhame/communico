// Transactional worker state. Network/rendering/tenant reads never enter here.
import type { Conn } from '#engine/store/db.ts';
import type { GatewayTarget } from '#engine/push/payload.ts';
import { badgeCount, cancelPushTarget } from './push-queue.ts';

export type PushTarget = GatewayTarget & {
  tenant: string;
  incarnation: string;
};
export type PushWork = {
  event: {
    seq: number;
    room: string;
    id: string;
    actions: unknown[];
    attempts: number;
  } | null;
  badge: { revision: number; attempts: number } | null;
  unread: number;
};

/** Bounded target-local retirement, followed by a coherent badge revision/count
 * and unread decision cut. A blocked event retry does not block badge clearing. */
export async function preparePushWork(
  tx: Conn,
  target: PushTarget,
  now: number,
  giveUpMs: number,
): Promise<PushWork> {
  const work: PushWork = { event: null, badge: null, unread: 0 };
  if (
    !(await tx.query(
      "SELECT 1 FROM push_targets WHERE incarnation=? AND state='active'",
      [target.incarnation],
    )).length
  ) return work;
  const rows = await tx.query(
    "SELECT d.*,n.read_ms,n.withdrawn,n.actions FROM push_delivery d LEFT JOIN notifications n ON n.seq=d.notification_seq WHERE d.incarnation=? AND d.state='pending' ORDER BY d.notification_seq LIMIT 32",
    [target.incarnation],
  );
  for (const row of rows) {
    let state: string | null = null;
    if (row.actions === null || row.read_ms !== null || row.withdrawn !== 0) {
      state = 'cancelled';
    } else if (now - Number(row.created_ms) >= giveUpMs) state = 'expired';
    if (state !== null) {
      await tx.execute(
        "UPDATE push_delivery SET state=?,error=? WHERE incarnation=? AND notification_seq=? AND state='pending'",
        [
          state,
          state === 'expired' ? 'delivery lifetime expired' : null,
          target.incarnation,
          row.notification_seq,
        ],
      );
      continue;
    }
    if (Number(row.next_ms) <= now) {
      work.event = {
        seq: Number(row.notification_seq),
        room: String(row.room),
        id: String(row.event),
        actions: JSON.parse(String(row.actions)),
        attempts: Number(row.attempts),
      };
    }
    break;
  }
  const badge =
    (await tx.query('SELECT * FROM push_badges WHERE incarnation=?', [
      target.incarnation,
    ]))[0];
  if (
    badge &&
    Number(badge.revision) >
      Math.max(Number(badge.sent_revision), Number(badge.expired_revision))
  ) {
    if (now - Number(badge.created_ms) >= giveUpMs) {
      await tx.execute(
        "UPDATE push_badges SET expired_revision=revision,error='delivery lifetime expired' WHERE incarnation=?",
        [target.incarnation],
      );
    } else if (work.event || Number(badge.next_ms) <= now) {
      work.badge = {
        revision: Number(badge.revision),
        attempts: Number(badge.attempts),
      };
    }
  }
  if (work.event || work.badge) work.unread = await badgeCount(tx, target.user);
  return work;
}

export async function cancelPushEvent(
  tx: Conn,
  target: PushTarget,
  seq: number,
): Promise<void> {
  await tx.execute(
    "UPDATE push_delivery SET state='cancelled' WHERE incarnation=? AND notification_seq=? AND state='pending'",
    [target.incarnation, seq],
  );
}

export async function finishPushWork(
  tx: Conn,
  target: PushTarget,
  work: PushWork,
): Promise<void> {
  if (work.event) {
    await tx.execute(
      "UPDATE push_delivery SET state='sent',error=NULL WHERE incarnation=? AND notification_seq=? AND state='pending'",
      [target.incarnation, work.event.seq],
    );
  }
  if (work.badge) {
    await tx.execute(
      'UPDATE push_badges SET sent_revision=MAX(sent_revision,?),attempts=CASE WHEN revision=? THEN 0 ELSE attempts END,next_ms=CASE WHEN revision=? THEN 0 ELSE next_ms END,error=CASE WHEN revision=? THEN NULL ELSE error END WHERE incarnation=?',
      [
        work.badge.revision,
        work.badge.revision,
        work.badge.revision,
        work.badge.revision,
        target.incarnation,
      ],
    );
  }
}

export async function retryPushWork(
  tx: Conn,
  target: PushTarget,
  work: PushWork,
  now: number,
  jitter: number,
): Promise<void> {
  const next = (attempts: number) =>
    now +
    Math.round(
      Math.min(
        3600000,
        1000 * 2 ** Math.min(attempts, 12) * (0.8 + jitter * 0.4),
      ),
    );
  if (work.event) {
    await tx.execute(
      "UPDATE push_delivery SET attempts=attempts+1,next_ms=?,error='gateway delivery failed' WHERE incarnation=? AND notification_seq=? AND state='pending'",
      [next(work.event.attempts), target.incarnation, work.event.seq],
    );
  }
  // A failure of an older payload must not delay a newer revision.
  if (work.badge) {
    await tx.execute(
      "UPDATE push_badges SET attempts=attempts+1,next_ms=?,error='gateway delivery failed' WHERE incarnation=? AND revision=?",
      [next(work.badge.attempts), target.incarnation, work.badge.revision],
    );
  }
}

/** Commit rejection before touching tenant truth. Replayed conditional deletion
 * is safe even if this stable pushkey was registered again while HTTP was active. */
export async function rejectPushTarget(
  tx: Conn,
  target: PushTarget,
): Promise<void> {
  await tx.execute(
    'INSERT INTO push_rejections(tenant,user,app_id,pushkey,incarnation) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
    [
      target.tenant,
      target.user,
      target.app_id,
      target.pushkey,
      target.incarnation,
    ],
  );
  await cancelPushTarget(tx, target.incarnation);
  await tx.execute(
    "UPDATE push_targets SET state='rejected' WHERE incarnation=?",
    [target.incarnation],
  );
}
