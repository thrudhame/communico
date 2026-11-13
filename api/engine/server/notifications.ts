// Server-owned push ledger and exact summaries. All effects use the caller's
// connection, committing with live publication or the receipt that caused them.
import type { Conn, Database } from '#engine/store/db.ts';
import type { PushPublication } from '#engine/server/push-project.ts';
import { enqueuePush, queueBadge, removePushWork } from './push-queue.ts';
import {
  pruneNotificationHistory,
  syncNotificationHistory,
} from './notification-history.ts';
import {
  receiptRelationPending,
  receiptTargetInThread,
  threadOfEvent,
} from '#engine/server/read.ts';

type Reader = Pick<Database, 'query'>;
export type Counts = { notification_count: number; highlight_count: number };

/** The lifecycle owners retire the complete projection, not just its summaries.
 * Runs in their server transaction so replay cannot retain orphaned read facts. */
export async function removeNotificationFacts(
  tx: Conn,
  scope: { room: string } | { user: string },
): Promise<void> {
  const column = 'room' in scope ? 'room' : 'user';
  const value = 'room' in scope ? scope.room : scope.user;
  await removePushWork(tx, scope);
  for (
    const table of [
      'push_evaluations',
      'notifications',
      'notification_counts',
      'notification_horizons',
      'notification_receipt_refs',
      'notification_changes',
      'notification_own_events',
      'notification_history',
    ]
  ) {
    await tx.execute(`DELETE FROM ${table} WHERE ${column}=?`, [value]);
  }
}

async function next(tx: Conn): Promise<number> {
  await tx.execute(
    "INSERT INTO counters(name,value) VALUES('notifications',0) ON CONFLICT DO NOTHING",
  );
  await tx.execute(
    "UPDATE counters SET value=value+1 WHERE name='notifications'",
  );
  return Number(
    (await tx.query("SELECT value FROM counters WHERE name='notifications'"))[0]
      .value,
  );
}

async function delta(
  tx: Conn,
  user: string,
  room: string,
  thread: string,
  unread: number,
  highlight: number,
): Promise<void> {
  await tx.execute(
    'INSERT INTO notification_counts(user,room,thread,unread,highlight) VALUES(?,?,?,0,0) ON CONFLICT DO NOTHING',
    [user, room, thread],
  );
  await tx.execute(
    'UPDATE notification_counts SET unread=unread+?,highlight=highlight+? WHERE user=? AND room=? AND thread=?',
    [unread, highlight, user, room, thread],
  );
  await tx.execute(
    'INSERT INTO notification_changes(seq,user,room,thread) VALUES(?,?,?,?)',
    [await next(tx), user, room, thread],
  );
  await queueBadge(tx, user);
}

/** Effective read positions never move backwards, regardless of wire echo.
 * Unknown targets remain durable references, never a numeric-zero shortcut.
 * False means pending-reference admission is full, with no read effect. Replay
 * may defer that admission; a new receipt writer must reject atomically. */
export async function advanceNotificationRead(
  tx: Conn,
  user: string,
  room: string,
  scope: string,
  event: string,
  now: number,
): Promise<boolean> {
  const rows = await tx.query(
    'SELECT room,seq,standing,grounding FROM event_index WHERE event=?',
    [event],
  );
  const target = rows[0];
  const pending = target === undefined ||
    (target.room === room && target.standing === 'accepted' &&
      target.grounding !== 'grounded');
  const invalidScope = target !== undefined && target.room === room &&
    target.seq !== null && scope !== '' &&
    !await receiptTargetInThread(tx, room, event, scope);
  if (
    pending || (invalidScope && await receiptRelationPending(tx, room, event))
  ) {
    const existing = await tx.query(
      'SELECT 1 FROM notification_receipt_refs WHERE user=? AND room=? AND scope=? AND event=?',
      [user, room, scope, event],
    );
    if (
      !existing.length &&
      Number(
          (await tx.query(
            'SELECT COUNT(*) AS n FROM notification_receipt_refs WHERE user=? AND room=?',
            [user, room],
          ))[0].n,
        ) >= 256
    ) {
      return false;
    }
    await tx.execute(
      'INSERT INTO notification_receipt_refs(user,room,scope,event) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
      [user, room, scope, event],
    );
    return true;
  }
  await tx.execute(
    'DELETE FROM notification_receipt_refs WHERE user=? AND room=? AND scope=? AND event=?',
    [user, room, scope, event],
  );
  // Known history has no live-order position. A wrong-room, rejected or
  // unrelated target cannot borrow another event's cut or leave a pending ref.
  if (
    target.room !== room || target.seq === null ||
    target.standing !== 'accepted' || target.grounding !== 'grounded' ||
    invalidScope
  ) return true;
  const seq = Number(target.seq);
  await tx.execute(
    `INSERT INTO notification_horizons(user,room,scope,event_seq) VALUES(?,?,?,?)
    ON CONFLICT(user,room,scope) DO UPDATE SET event_seq=MAX(event_seq,excluded.event_seq)`,
    [user, room, scope, seq],
  );
  const horizon = Number(
    (await tx.query(
      'SELECT event_seq FROM notification_horizons WHERE user=? AND room=? AND scope=?',
      [user, room, scope],
    ))[0].event_seq,
  );
  const affected = await tx.query(
    `SELECT thread,COUNT(*) AS n,SUM(highlight) AS h FROM notifications
    WHERE user=? AND room=? AND read_ms IS NULL AND withdrawn=0 AND event_seq<=? AND (?='' OR thread=?) GROUP BY thread`,
    [user, room, horizon, scope, scope],
  );
  await tx.execute(
    `UPDATE notifications SET read_ms=? WHERE user=? AND room=? AND read_ms IS NULL AND event_seq<=? AND (?='' OR thread=?)`,
    [now, user, room, horizon, scope, scope],
  );
  for (const row of affected) {
    await delta(
      tx,
      user,
      room,
      String(row.thread),
      -Number(row.n),
      -Number(row.h),
    );
  }
  if (affected.length) {
    await tx.execute(
      'UPDATE notification_history SET read_ms=(SELECT read_ms FROM notifications WHERE seq=notification_history.seq) WHERE user=? AND room=?',
      [user, room],
    );
    await pruneNotificationHistory(tx, now);
  }
  return true;
}

export async function applyPushPublication(
  tx: Conn,
  room: string,
  event: string,
  eventSeq: number,
  pos: number,
  publication: PushPublication,
  now: number,
): Promise<void> {
  const thread = await threadOfEvent(tx, room, event);
  await tx.execute(
    'INSERT INTO notification_own_events(room,event,user,event_seq) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
    [room, event, publication.sender, eventSeq],
  );
  // Own events never notify; they implicitly read only their classified bucket.
  await advanceNotificationRead(
    tx,
    publication.sender,
    room,
    thread,
    event,
    now,
  );
  await applyDecisions(
    tx,
    room,
    event,
    eventSeq,
    pos,
    publication,
    now,
    thread,
    'room',
  );
}

/** An edge's arrival or redaction can affect only itself and descendants within
 * the shared classifier's three-hop bound. Reconcile saved decisions, never
 * evaluate history or publish a second alert. All effects share projection's tx. */
export async function reconcileNotificationEvent(
  tx: Conn,
  room: string,
  event: string,
  now: number,
): Promise<void> {
  const affected = new Set([event]);
  let frontier = [event];
  for (let hop = 0; hop < 3 && frontier.length; hop++) {
    const next: string[] = [];
    for (const parent of frontier) {
      const children = await tx.query(
        'SELECT event FROM relations WHERE room=? AND relates_to=?',
        [room, parent],
      );
      for (const row of children) {
        const child = String(row.event);
        if (!affected.has(child)) {
          affected.add(child);
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  for (const target of affected) {
    const pending = await tx.query(
      'SELECT user,scope FROM notification_receipt_refs WHERE room=? AND event=?',
      [room, target],
    );
    for (const row of pending) {
      await advanceNotificationRead(
        tx,
        String(row.user),
        room,
        String(row.scope),
        target,
        now,
      );
    }
    // An event ID resolves only in its actual room, even if an earlier receipt
    // claimed another room before the event was held.
    await tx.execute(
      'DELETE FROM notification_receipt_refs WHERE event=? AND room<>? AND EXISTS (SELECT 1 FROM event_index WHERE event=?)',
      [target, room, target],
    );
    const thread = await threadOfEvent(tx, room, target);
    const own = await tx.query(
      'SELECT user FROM notification_own_events WHERE room=? AND event=?',
      [room, target],
    );
    for (const row of own) {
      await advanceNotificationRead(
        tx,
        String(row.user),
        room,
        thread,
        target,
        now,
      );
    }
    const redacted = (await tx.query(
      'SELECT 1 FROM redactions WHERE room=? AND target=?',
      [room, target],
    )).length > 0;
    const rows = await tx.query(
      'SELECT seq,user,thread,event_seq,highlight,read_ms FROM notifications WHERE room=? AND event=? AND withdrawn=0',
      [room, target],
    );
    for (const row of rows) {
      if (!redacted && row.thread === thread) continue;
      const user = String(row.user);
      const priorUnread = row.read_ms === null;
      const horizon = (await tx.query(
        "SELECT MAX(event_seq) AS m FROM notification_horizons WHERE user=? AND room=? AND scope IN ('',?)",
        [user, room, thread],
      ))[0].m;
      const read = Number(horizon ?? 0) >= Number(row.event_seq);
      await tx.execute(
        'UPDATE notifications SET thread=?,withdrawn=?,read_ms=? WHERE seq=?',
        [
          thread,
          redacted ? 1 : 0,
          read ? Number(row.read_ms ?? now) : null,
          Number(row.seq),
        ],
      );
      await syncNotificationHistory(tx, Number(row.seq), now);
      await delta(
        tx,
        user,
        room,
        String(row.thread),
        priorUnread ? -1 : 0,
        priorUnread ? -Number(row.highlight) : 0,
      );
      if (!redacted) {
        await delta(
          tx,
          user,
          room,
          thread,
          read ? 0 : 1,
          read ? 0 : Number(row.highlight),
        );
      }
    }
  }
}

/** OOB events share recipient/event uniqueness with later held-room truth. */
export async function applyInvitePush(
  tx: Conn,
  room: string,
  event: string,
  eventSeq: number,
  publication: PushPublication,
  now: number,
): Promise<void> {
  await applyDecisions(
    tx,
    room,
    event,
    eventSeq,
    eventSeq,
    publication,
    now,
    'main',
    'invite',
  );
  for (const input of publication.decisions) await queueBadge(tx, input.user);
}

async function applyDecisions(
  tx: Conn,
  room: string,
  event: string,
  eventSeq: number,
  pos: number,
  publication: PushPublication,
  now: number,
  thread: string,
  source: string,
): Promise<void> {
  for (const input of publication.decisions) {
    const inserted = await tx.execute(
      `INSERT INTO push_evaluations(tenant,user,event,room,event_seq,source,source_pos,rule_revision,ignore_revision,version,rule_id,rule_kind)
      VALUES(?,?,?,?,?,?,?,?,?,1,?,?) ON CONFLICT DO NOTHING`,
      [
        input.tenant,
        input.user,
        event,
        room,
        eventSeq,
        source,
        pos,
        input.ruleRevision,
        input.ignoreRevision,
        input.decision?.ruleId ?? null,
        input.decision?.kind ?? null,
      ],
    );
    if (!inserted || !input.decision?.notify) continue;
    // Current receipts seed upgrades too; the independent horizons retain the
    // farther position even after a lagging public/private wire update.
    const receipts = await tx.query(
      'SELECT event_ids,thread_id FROM receipts WHERE user_id=? AND room_id=?',
      [input.user, room],
    );
    for (const receipt of receipts) {
      for (const eventId of JSON.parse(String(receipt.event_ids)) as string[]) {
        await advanceNotificationRead(
          tx,
          input.user,
          room,
          String(receipt.thread_id),
          eventId,
          now,
        );
      }
    }
    const horizons = await tx.query(
      "SELECT MAX(event_seq) AS m FROM notification_horizons WHERE user=? AND room=? AND scope IN ('',?)",
      [input.user, room, thread],
    );
    const read = Number(horizons[0].m ?? 0) >= eventSeq;
    const withdrawn = (await tx.query(
      'SELECT 1 FROM redactions WHERE room=? AND target=?',
      [room, event],
    )).length > 0;
    const notificationSeq = await next(tx);
    await tx.execute(
      `INSERT INTO notifications(seq,tenant,user,event,room,event_seq,thread,actions,highlight,created_ms,read_ms,withdrawn) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        notificationSeq,
        input.tenant,
        input.user,
        event,
        room,
        eventSeq,
        thread,
        JSON.stringify(input.decision.actions),
        input.decision.highlight ? 1 : 0,
        now,
        read ? now : null,
        withdrawn ? 1 : 0,
      ],
    );
    if (!read && !withdrawn) {
      await delta(
        tx,
        input.user,
        room,
        thread,
        1,
        input.decision.highlight ? 1 : 0,
      );
    }
    await syncNotificationHistory(tx, notificationSeq, now);
    if (!read && !withdrawn) {
      for (const incarnation of input.pusherIncarnations ?? []) {
        await enqueuePush(
          tx,
          incarnation,
          notificationSeq,
          input.user,
          room,
          event,
          now,
        );
      }
    }
  }
}

/** Withdraw an invite's contribution without deleting its evaluation identity. */
export async function withdrawInvitePush(
  tx: Conn,
  user: string,
  room: string,
  event: string,
): Promise<void> {
  await queueBadge(tx, user);
  const rows = await tx.query(
    `SELECT n.thread,n.highlight,n.read_ms FROM notifications n JOIN push_evaluations e
    ON e.tenant=n.tenant AND e.user=n.user AND e.event=n.event
    WHERE n.user=? AND n.room=? AND n.event=? AND n.withdrawn=0 AND e.source='invite'`,
    [user, room, event],
  );
  if (!rows.length) return;
  await tx.execute(
    'UPDATE notifications SET withdrawn=1 WHERE user=? AND room=? AND event=?',
    [user, room, event],
  );
  await tx.execute(
    'DELETE FROM notification_history WHERE seq IN (SELECT seq FROM notifications WHERE user=? AND room=? AND event=?)',
    [user, room, event],
  );
  for (const row of rows) {
    if (row.read_ms === null) {
      await delta(
        tx,
        user,
        room,
        String(row.thread),
        -1,
        -Number(row.highlight),
      );
    }
  }
}

/** Counts and change-room membership are read by sync in its maxima snapshot. */
export async function notificationChanged(
  tx: Reader,
  user: string,
  since: number,
): Promise<boolean> {
  return (await tx.query(
    'SELECT 1 FROM notification_changes WHERE user=? AND seq>? LIMIT 1',
    [user, since],
  )).length > 0;
}

export async function notificationSnapshot(
  tx: Reader,
  user: string,
  since: number,
) {
  const rows = await tx.query(
    'SELECT room,thread,unread,highlight FROM notification_counts WHERE user=?',
    [user],
  );
  const rooms = new Map<string, Map<string, Counts>>();
  for (const row of rows) {
    const room = String(row.room);
    if (!rooms.has(room)) rooms.set(room, new Map());
    rooms.get(room)!.set(String(row.thread), {
      notification_count: Number(row.unread),
      highlight_count: Number(row.highlight),
    });
  }
  const changes = await tx.query(
    'SELECT DISTINCT room FROM notification_changes WHERE user=? AND seq>?',
    [user, since],
  );
  return { rooms, changed: new Set(changes.map((r) => String(r.room))) };
}

export function roomNotificationCounts(
  buckets: Map<string, Counts> | undefined,
): Counts {
  const total = { notification_count: 0, highlight_count: 0 };
  for (const count of buckets?.values() ?? []) {
    total.notification_count += count.notification_count;
    total.highlight_count += count.highlight_count;
  }
  return total;
}

/** Split sync is another view of the same exact buckets. Empty thread maps are
 * omitted per sync.yaml; the room and its numeric main zero still clear counts. */
export function syncNotificationCounts(
  buckets: Map<string, Counts> | undefined,
  threaded: boolean,
): {
  unread_notifications: Counts;
  unread_thread_notifications?: Record<string, Counts>;
} {
  if (!threaded) {
    return { unread_notifications: roomNotificationCounts(buckets) };
  }
  const threads = [...buckets ?? []].filter(([thread]) => thread !== 'main');
  return {
    unread_notifications: buckets?.get('main') ??
      { notification_count: 0, highlight_count: 0 },
    ...(threads.some(([, counts]) => counts.notification_count > 0)
      ? { unread_thread_notifications: Object.fromEntries(threads) }
      : {}),
  };
}
