// Server-owned push ledger and exact summaries. All effects use the caller's
// connection, committing with live publication or the receipt that caused them.
import type { Conn, Database } from '#engine/store/db.ts';
import type { PushPublication } from '#engine/server/push-project.ts';
import { threadOfEvent } from '#engine/server/read.ts';

type Reader = Pick<Database, 'query'>;
export type Counts = { notification_count: number; highlight_count: number };

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
}

/** Effective read positions never move backwards, regardless of wire echo.
 * Unknown targets remain durable references, never a numeric-zero shortcut. */
export async function advanceNotificationRead(
  tx: Conn,
  user: string,
  room: string,
  scope: string,
  event: string,
  now: number,
): Promise<void> {
  const rows = await tx.query(
    'SELECT seq FROM event_index WHERE room=? AND event=? AND seq IS NOT NULL',
    [room, event],
  );
  if (!rows.length) {
    await tx.execute(
      'INSERT INTO notification_receipt_refs(user,room,scope,event) VALUES(?,?,?,?) ON CONFLICT DO NOTHING',
      [user, room, scope, event],
    );
    return;
  }
  const seq = Number(rows[0].seq);
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
  // Resolve receipts that arrived before this target was projected.
  const pending = await tx.query(
    'SELECT user,scope FROM notification_receipt_refs WHERE room=? AND event=?',
    [room, event],
  );
  for (const row of pending) {
    await advanceNotificationRead(
      tx,
      String(row.user),
      room,
      String(row.scope),
      event,
      now,
    );
  }
  await tx.execute(
    'DELETE FROM notification_receipt_refs WHERE room=? AND event=?',
    [room, event],
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
  for (const input of publication.decisions) {
    const inserted = await tx.execute(
      `INSERT INTO push_evaluations(tenant,user,event,room,event_seq,source,source_pos,rule_revision,ignore_revision,version,rule_id,rule_kind)
      VALUES(?,?,?,?,?,'room',?,?,?,1,?,?) ON CONFLICT DO NOTHING`,
      [
        input.tenant,
        input.user,
        event,
        room,
        eventSeq,
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
      'SELECT event_id,thread_id FROM receipts WHERE user_id=? AND room_id=?',
      [input.user, room],
    );
    for (const receipt of receipts) {
      await advanceNotificationRead(
        tx,
        input.user,
        room,
        String(receipt.thread_id),
        String(receipt.event_id),
        now,
      );
    }
    const horizons = await tx.query(
      "SELECT MAX(event_seq) AS m FROM notification_horizons WHERE user=? AND room=? AND scope IN ('',?)",
      [input.user, room, thread],
    );
    const read = Number(horizons[0].m ?? 0) >= eventSeq;
    const notificationSeq = await next(tx);
    await tx.execute(
      `INSERT INTO notifications(seq,tenant,user,event,room,event_seq,thread,actions,highlight,created_ms,read_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
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
      ],
    );
    if (!read) {
      await delta(
        tx,
        input.user,
        room,
        thread,
        1,
        input.decision.highlight ? 1 : 0,
      );
    }
  }
}

/** Counts and change-room membership are read by sync in its maxima snapshot. */
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
