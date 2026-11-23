// Server-owned push ledger and exact summaries. All effects use the caller's
// connection, committing with live publication or the receipt that caused them.
import type { Conn, Database } from '#engine/store/db.ts';
import type { PushPublication } from '#engine/server/push-project.ts';
import type { RegisterOperation } from '#engine/facade/registers.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import {
  acceptNotificationOperation,
  captureNotificationOperations,
  notificationAuthority,
  recordNotificationOperation,
  savedNotification,
  selectedNotificationOperation,
} from './notification-operations.ts';
import type { PublicationDecision } from './push-project.ts';
import type { PushKind } from '#engine/push/defaults.ts';
import { eventStreamTx } from './stream.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  graphNotificationRead,
  graphReadClosure,
  graphReceiptsEnabled,
  rememberGraphRead,
} from '#engine/server/receipt-frontier.ts';
import {
  applyPublicationPushQueue,
  enqueuePush,
  queueBadge,
  removePushWork,
} from './push-queue.ts';
import {
  insertPublicationRows,
  reservePublicationCounter,
} from './publication-rows.ts';
import type { Value } from '#engine/store/ffi.ts';
import {
  notificationHistoryCutoff,
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
  if ('user' in scope) {
    // The existing account lifecycle owner calls this once deactivation is
    // durable. Retained facts may still arrive, but cannot recreate its view.
    await tx.execute(
      'INSERT INTO notification_retired_users(user) VALUES(?) ON CONFLICT DO NOTHING',
      [scope.user],
    );
  } else {
    await tx.execute(
      'INSERT INTO notification_retired_rooms(room) VALUES(?) ON CONFLICT DO NOTHING',
      [scope.room],
    );
  }
  await tx.execute(
    `UPDATE domain_operations SET applied=-1 WHERE kind='notification' AND json_extract(payload_json,'$.${column}')=?`,
    [value],
  );
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
      'notification_graph_reads',
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
  dispatch = true,
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
  if (dispatch) await queueBadge(tx, user);
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
  const graph = await graphReceiptsEnabled(tx);
  const pending = target === undefined ||
    (target.room === room && target.standing === 'accepted' &&
      target.grounding !== 'grounded');
  const invalidScope = target !== undefined && target.room === room &&
    (graph || target.seq !== null) && scope !== '' &&
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
    target.room !== room || (!graph && target.seq === null) ||
    target.standing !== 'accepted' || target.grounding !== 'grounded' ||
    invalidScope
  ) return true;
  // Preserve exact admitted target identity even before F2 activation, so a
  // later transition never has to reinterpret a local numeric read horizon.
  await rememberGraphRead(tx, user, room, scope, event);
  if (graph) {
    await clearGraphNotifications(tx, user, room, now);
    return true;
  }
  const seq = Number(target.seq);
  await tx.execute(
    `INSERT INTO notification_horizons(user,room,scope,event_seq) VALUES(?,?,?,?)
    ON CONFLICT(user,room,scope) DO UPDATE SET event_seq=excluded.event_seq
    WHERE excluded.event_seq>notification_horizons.event_seq`,
    [user, room, scope, seq],
  );
  const horizon = Number(
    (await tx.query(
      'SELECT event_seq FROM notification_horizons WHERE user=? AND room=? AND scope=?',
      [user, room, scope],
    ))[0].event_seq,
  );
  const unread =
    "user=? AND room=? AND read_ms IS NULL AND event_seq<=? AND (?='' OR thread=?)";
  const bounds = [user, room, horizon, scope, scope];
  const affected = await tx.query(
    `SELECT thread,COUNT(*) AS n,SUM(highlight) AS h FROM notifications
    WHERE ${unread} AND withdrawn=0 GROUP BY thread`,
    bounds,
  );
  if (affected.length) {
    // Listing retention follows the same unread delta before its facts change.
    // Already-read room history is neither rewritten nor hydrated for a receipt.
    await tx.execute(
      `UPDATE notification_history SET read_ms=? WHERE seq IN
      (SELECT seq FROM notifications WHERE ${unread})`,
      [now, ...bounds],
    );
  }
  await tx.execute(
    `UPDATE notifications SET read_ms=? WHERE ${unread}`,
    [now, ...bounds],
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
    await pruneNotificationHistory(tx, now);
  }
  return true;
}

async function notificationIsRead(
  tx: Conn,
  user: string,
  room: string,
  thread: string,
  event: string,
  seq: number,
): Promise<boolean> {
  if (await graphReceiptsEnabled(tx)) {
    return await graphNotificationRead(tx, user, room, thread, event);
  }
  const [horizon] = await tx.query(
    "SELECT MAX(event_seq) AS m FROM notification_horizons WHERE user=? AND room=? AND scope IN ('',?)",
    [user, room, thread],
  );
  return Number(horizon.m ?? 0) >= seq;
}

/** Work on unread facts only. A local seq remains an index key, not evidence of
 * ancestry. Unknown edges leave the fact unread until projection supplies them. */
async function clearGraphNotifications(
  tx: Conn,
  user: string,
  room: string,
  now: number,
): Promise<void> {
  const rows = await tx.query(
    'SELECT seq,event,thread,highlight,withdrawn FROM notifications WHERE user=? AND room=? AND read_ms IS NULL',
    [user, room],
  );
  let changed = false;
  const closures = new Map<string, Set<string>>();
  for (const row of rows) {
    const thread = String(row.thread);
    let closure = closures.get(thread);
    if (!closure) {
      closure = await graphReadClosure(tx, user, room, thread);
      closures.set(thread, closure);
    }
    if (!closure.has(String(row.event))) continue;
    await tx.execute(
      'UPDATE notifications SET read_ms=? WHERE seq=? AND read_ms IS NULL',
      [now, Number(row.seq)],
    );
    await syncNotificationHistory(tx, Number(row.seq), now);
    if (!Number(row.withdrawn)) {
      await delta(
        tx,
        user,
        room,
        String(row.thread),
        -1,
        -Number(row.highlight),
      );
    }
    changed = true;
  }
  if (changed) await pruneNotificationHistory(tx, now);
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

export type IndependentPush = {
  room: string;
  event: string;
  pos: number;
  publication: PushPublication;
};

/** Receipt seeding is durable read-marker work, not per-notification work.
 * General publication and independent eligibility share this fresh witness.
 * Graph identity alone cannot repair a missing standalone/F1 horizon. Unknown
 * targets still enter the existing ordered pending-reference owner. */
async function notificationReceiptSeeds(
  tx: Conn,
  keys: readonly { room: string; user?: string }[],
  graph: boolean,
): Promise<{ user: string; room: string; scope: string; event: string }[]> {
  if (!keys.length) return [];
  const rows = await tx.query(
    `SELECT DISTINCT r.user_id AS user,r.room_id AS room,r.thread_id AS scope,CAST(e.value AS TEXT) AS event
    FROM json_each(?) j JOIN receipts r ON r.room_id=CAST(json_extract(j.value,'$.room') AS TEXT)
      AND (json_type(j.value,'$.user') IS NULL OR r.user_id=CAST(json_extract(j.value,'$.user') AS TEXT)),json_each(r.event_ids) e
    LEFT JOIN event_index i ON i.event=CAST(e.value AS TEXT) AND i.room=r.room_id
    WHERE NOT EXISTS (
      SELECT 1 FROM notification_graph_reads g WHERE g.user=r.user_id AND g.room=r.room_id AND g.scope=r.thread_id AND g.event=CAST(e.value AS TEXT))
    OR (?=0
      AND i.seq IS NOT NULL AND i.standing='accepted' AND i.grounding='grounded'
      AND NOT EXISTS (SELECT 1 FROM notification_horizons h
        WHERE h.user=r.user_id AND h.room=r.room_id AND h.scope=r.thread_id AND h.event_seq>=i.seq))`,
    [JSON.stringify(keys), graph ? 1 : 0],
  );
  return rows.map((row) => ({
    user: String(row.user),
    room: String(row.room),
    scope: String(row.scope),
    event: String(row.event),
  }));
}

/** Capture only inside the owning server attempt. Independent plain events
 * have no relation, pending-reference, replay or graph dependencies; all other
 * meanings retain the general ordered application path below. */
export async function captureIndependentPushes(
  tx: Conn,
  inputs: readonly IndependentPush[],
): Promise<
  ((sequences: readonly number[], now: number) => Promise<void>) | null
> {
  if (await graphReceiptsEnabled(tx)) return null;
  const events = JSON.stringify(inputs.map((i) => i.event));
  const rooms = JSON.stringify(inputs.map((i) => i.room));
  const dependencies = await tx.query(
    `
    SELECT 1 FROM json_each(?) j JOIN relations r ON r.event=CAST(j.value AS TEXT)
    UNION ALL SELECT 1 FROM json_each(?) j JOIN relations r ON r.relates_to=CAST(j.value AS TEXT)
    UNION ALL SELECT 1 FROM json_each(?) j JOIN notification_receipt_refs r ON r.room=CAST(j.value AS TEXT)
    UNION ALL SELECT 1 FROM json_each(?) j JOIN notification_receipt_refs r ON r.event=CAST(j.value AS TEXT)
    UNION ALL SELECT 1 FROM json_each(?) j JOIN push_evaluations r ON r.event=CAST(j.value AS TEXT)
    UNION ALL SELECT 1 FROM json_each(?) j JOIN notification_own_events r ON r.event=CAST(j.value AS TEXT)
    UNION ALL SELECT 1 FROM json_each(?) j JOIN redactions r ON r.target=CAST(j.value AS TEXT)
    LIMIT 1`,
    [events, events, rooms, events, events, events, events],
  );
  if (dependencies.length) return null;
  if (
    (await notificationReceiptSeeds(
      tx,
      [...new Set(inputs.map((i) => i.room))].map((room) => ({ room })),
      false,
    )).length
  ) return null;
  const horizons = await tx.query(
    'SELECT h.user,h.room,h.scope,h.event_seq FROM json_each(?) j JOIN notification_horizons h ON h.room=CAST(j.value AS TEXT)',
    [rooms],
  );
  if (
    (await tx.query(
      `SELECT 1 FROM json_each(?) j JOIN receipts r ON r.room_id=CAST(j.value AS TEXT) JOIN notification_horizons h ON h.user=r.user_id AND h.room=r.room_id AND h.scope=r.thread_id
    JOIN notifications n ON n.user=h.user AND n.room=h.room AND n.event_seq<=h.event_seq AND (h.scope='' OR n.thread=h.scope)
    WHERE n.read_ms IS NULL LIMIT 1`,
      [rooms],
    )).length
  ) return null;
  const unread = await tx.query(
    `SELECT n.seq,n.user,n.room,n.event_seq,n.highlight,n.withdrawn FROM json_each(?) j
    JOIN notifications n ON n.room=CAST(json_extract(j.value,'$.room') AS TEXT) AND n.user=CAST(json_extract(j.value,'$.sender') AS TEXT)
    WHERE n.read_ms IS NULL AND n.thread='main'`,
    [JSON.stringify(
      inputs.map((i) => ({ room: i.room, sender: i.publication.sender })),
    )],
  );
  return async (sequences, now) => {
    const evaluations: Value[][] = [];
    const notifications: Value[][] = [];
    const changes: Value[][] = [];
    const countDeltas = new Map<
      string,
      { user: string; room: string; unread: number; highlight: number }
    >();
    const own: Value[][] = [];
    const graphReads: Value[][] = [];
    const reads: Value[][] = [];
    const cleared: number[] = [];
    const historyCleared: number[] = [];
    const badges: { user: string; incarnation?: string }[] = [];
    const deliveries: [string, number, string, string, string, number][] = [];
    let positions = 0;
    const horizon = (user: string, room: string, scope: string) =>
      Number(
        horizons.find((h) =>
          h.user === user && h.room === room && h.scope === scope
        )?.event_seq ?? 0,
      );
    const delta = (user: string, room: string, n: number, h: number) => {
      const key = JSON.stringify([user, room]);
      const prior = countDeltas.get(key) ??
        { user, room, unread: 0, highlight: 0 };
      prior.unread += n;
      prior.highlight += h;
      countDeltas.set(key, prior);
      changes.push([positions++, user, room, 'main']);
      badges.push({ user });
    };
    for (let at = 0; at < inputs.length; at++) {
      const { room, event, pos, publication } = inputs[at];
      const eventSeq = sequences[at];
      own.push([room, event, publication.sender, eventSeq]);
      graphReads.push([publication.sender, room, 'main', event]);
      const senderHorizon = Math.max(
        eventSeq,
        horizon(publication.sender, room, 'main'),
      );
      reads.push([publication.sender, room, 'main', senderHorizon]);
      const clearedHere = unread.filter((n) =>
        n.room === room && n.user === publication.sender &&
        Number(n.event_seq) <= senderHorizon
      );
      cleared.push(...clearedHere.map((n) => Number(n.seq)));
      const counted = clearedHere.filter((n) => !Number(n.withdrawn));
      if (counted.length) {
        historyCleared.push(...clearedHere.map((n) => Number(n.seq)));
        delta(
          publication.sender,
          room,
          -counted.length,
          -counted.reduce((sum, n) => sum + Number(n.highlight), 0),
        );
      }
      for (const input of publication.decisions) {
        evaluations.push([
          input.tenant,
          input.user,
          event,
          room,
          eventSeq,
          'room',
          pos,
          input.ruleRevision,
          input.ignoreRevision,
          1,
          input.decision?.ruleId ?? null,
          input.decision?.kind ?? null,
        ]);
        if (!input.decision?.notify) continue;
        const read = Math.max(
          horizon(input.user, room, ''),
          horizon(input.user, room, 'main'),
          input.user === publication.sender ? senderHorizon : 0,
        ) >= eventSeq;
        const seq = positions++;
        notifications.push([
          seq,
          input.tenant,
          input.user,
          event,
          room,
          eventSeq,
          'main',
          JSON.stringify(input.decision.actions),
          input.decision.highlight ? 1 : 0,
          now,
          read ? now : null,
          0,
        ]);
        if (!read) delta(input.user, room, 1, input.decision.highlight ? 1 : 0);
        if (!read) {
          for (const incarnation of input.pusherIncarnations ?? []) {
            deliveries.push([incarnation, seq, input.user, room, event, now]);
            badges.push({ user: input.user, incarnation });
          }
        }
      }
    }
    const first = positions
      ? await reservePublicationCounter(tx, 'notifications', positions)
      : 0;
    for (const row of notifications) row[0] = Number(row[0]) + first;
    for (const row of changes) row[0] = Number(row[0]) + first;
    for (const row of deliveries) row[1] += first;
    await insertPublicationRows(tx, 'notification_own_events', [
      'room',
      'event',
      'user',
      'event_seq',
    ], own);
    await insertPublicationRows(tx, 'notification_graph_reads', [
      'user',
      'room',
      'scope',
      'event',
    ], graphReads);
    await insertPublicationRows(
      tx,
      'notification_horizons',
      ['user', 'room', 'scope', 'event_seq'],
      reads,
      `ON CONFLICT(user,room,scope) DO UPDATE SET event_seq=excluded.event_seq WHERE excluded.event_seq>notification_horizons.event_seq`,
    );
    if (historyCleared.length) {
      await tx.execute(
        'UPDATE notification_history SET read_ms=? WHERE seq IN (SELECT value FROM json_each(?))',
        [now, JSON.stringify(historyCleared)],
      );
    }
    if (cleared.length) {
      await tx.execute(
        'UPDATE notifications SET read_ms=? WHERE seq IN (SELECT value FROM json_each(?)) AND read_ms IS NULL',
        [now, JSON.stringify(cleared)],
      );
    }
    // The individual path prunes before inserting any new listing facts. A
    // zero-day policy therefore must not remove a later event's unread row.
    if (historyCleared.length) await pruneNotificationHistory(tx, now);
    await insertPublicationRows(tx, 'push_evaluations', [
      'tenant',
      'user',
      'event',
      'room',
      'event_seq',
      'source',
      'source_pos',
      'rule_revision',
      'ignore_revision',
      'version',
      'rule_id',
      'rule_kind',
    ], evaluations);
    await insertPublicationRows(tx, 'notifications', [
      'seq',
      'tenant',
      'user',
      'event',
      'room',
      'event_seq',
      'thread',
      'actions',
      'highlight',
      'created_ms',
      'read_ms',
      'withdrawn',
    ], notifications);
    await insertPublicationRows(
      tx,
      'notification_counts',
      ['user', 'room', 'thread', 'unread', 'highlight'],
      [...countDeltas.values()].map((d) => [d.user, d.room, 'main', 0, 0]),
    );
    if (countDeltas.size) {
      // An INSERT's CHECK constraints precede conflict resolution. Negative
      // deltas are updates to existing nonnegative totals, never insert values.
      // Probe the typed composite key, then update only those rowids. The native
      // planner does not turn a composite IN predicate into indexed lookups.
      await tx.execute(
        `WITH deltas AS (
        SELECT CAST(json_extract(value,'$.user') AS TEXT) AS user,CAST(json_extract(value,'$.room') AS TEXT) AS room,
          json_extract(value,'$.unread') AS unread,json_extract(value,'$.highlight') AS highlight FROM json_each(?)
      ) UPDATE notification_counts SET
        unread=unread+(SELECT d.unread FROM deltas d WHERE d.user=notification_counts.user AND d.room=notification_counts.room),
        highlight=highlight+(SELECT d.highlight FROM deltas d WHERE d.user=notification_counts.user AND d.room=notification_counts.room)
      WHERE rowid IN (SELECT n.rowid FROM deltas d JOIN notification_counts n
        ON n.user=d.user AND n.room=d.room AND n.thread='main')`,
        [JSON.stringify([...countDeltas.values()])],
      );
    }
    await insertPublicationRows(tx, 'notification_changes', [
      'seq',
      'user',
      'room',
      'thread',
    ], changes);
    if (notifications.length) {
      await tx.execute(
        `INSERT INTO notification_history(seq,user,room,highlight,read_ms)
      SELECT seq,user,room,highlight,read_ms FROM notifications WHERE seq IN (SELECT value FROM json_each(?)) AND withdrawn=0 AND (read_ms IS NULL OR read_ms>?)`,
        [
          JSON.stringify(notifications.map((n) => n[0])),
          notificationHistoryCutoff(now),
        ],
      );
    }
    await applyPublicationPushQueue(tx, badges, deliveries, now);
  };
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
    // Read markers and local own-event reads are authoritative before a saved
    // imported decision is materialized. No transient unread row may dispatch.
    await projectImportedNotificationEvent(tx, room, target, now);
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
      const read = await notificationIsRead(
        tx,
        user,
        room,
        thread,
        target,
        Number(row.event_seq),
      );
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

/** Revisit graph reads after all event-local work in one committed prefix. */
export async function reconcileNotificationReads(
  tx: Conn,
  room: string,
  now: number,
): Promise<void> {
  if (await graphReceiptsEnabled(tx)) {
    const users = await tx.query(
      'SELECT DISTINCT user FROM notification_graph_reads WHERE room=?',
      [room],
    );
    for (const row of users) {
      await clearGraphNotifications(tx, String(row.user), room, now);
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
  source: 'room' | 'invite',
): Promise<void> {
  for (const input of publication.decisions) {
    if (
      (await tx.query('SELECT 1 FROM notification_retired_users WHERE user=?', [
        input.user,
      ])).length
    ) continue;
    const [prior] = await tx.query(
      'SELECT operation_id,native FROM push_evaluations WHERE tenant=? AND user=? AND event=?',
      [input.tenant, input.user, event],
    );
    const authority = await notificationAuthority(tx);
    if (
      prior &&
      Number(prior.native) === 1
    ) {
      if (authority && prior.operation_id === null) {
        await captureNotificationOperations(tx, input.user);
      }
      continue;
    }
    const recorded = await recordNotificationOperation(
      tx,
      room,
      event,
      source,
      input,
      now,
    );
    if (
      recorded &&
      (await tx.query(
        'SELECT 1 FROM domain_operations WHERE operation_id=? AND applied=-1',
        [recorded.operation.operationId],
      )).length
    ) continue;
    if (prior) {
      await removeDecisionProjection(
        tx,
        input.tenant,
        input.user,
        event,
        false,
      );
    }
    await projectDecision(
      tx,
      room,
      event,
      eventSeq,
      pos,
      recorded
        ? savedDecisionInput(
          savedNotification(recorded.operation),
          input.pusherIncarnations,
        )
        : input,
      now,
      thread,
      source,
      recorded?.operation.operationId ?? null,
      recorded?.created ?? true,
      recorded ? savedNotification(recorded.operation).createdMs : now,
      true,
    );
  }
}

function savedDecisionInput(
  value: ReturnType<typeof savedNotification>,
  pusherIncarnations?: string[],
): PublicationDecision {
  return {
    tenant: value.tenant,
    user: value.user,
    ruleRevision: value.ruleRevision,
    ignoreRevision: value.ignoreRevision,
    pusherIncarnations,
    decision: value.ruleId === null ? null : {
      ruleId: value.ruleId,
      kind: value.ruleKind as PushKind,
      notify: value.notify,
      actions: value.actions,
      highlight: value.highlight,
      tweaks: {},
    },
  };
}

async function projectDecision(
  tx: Conn,
  room: string,
  event: string,
  eventSeq: number,
  pos: number,
  input: PublicationDecision,
  now: number,
  thread: string,
  source: string,
  operationId: string | null,
  dispatch: boolean,
  createdMs = now,
  native = dispatch,
): Promise<void> {
  const inserted = await tx.execute(
    `INSERT INTO push_evaluations(tenant,user,event,room,event_seq,source,source_pos,rule_revision,ignore_revision,version,rule_id,rule_kind,operation_id,native)
       VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?) ON CONFLICT DO NOTHING`,
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
      operationId,
      native ? 1 : 0,
    ],
  );
  if (!inserted || !input.decision?.notify) return;
  // Native publication seeds only missing durable read facts. Imported saved
  // notifications never advance local read markers or dispatch pushes.
  if (dispatch) {
    for (
      const seed of await notificationReceiptSeeds(
        tx,
        [{ room, user: input.user }],
        await graphReceiptsEnabled(tx),
      )
    ) {
      await advanceNotificationRead(
        tx,
        seed.user,
        seed.room,
        seed.scope,
        seed.event,
        now,
      );
    }
  }
  const read = await notificationIsRead(
    tx,
    input.user,
    room,
    thread,
    event,
    eventSeq,
  );
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
      createdMs,
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
      dispatch,
    );
  }
  await syncNotificationHistory(tx, notificationSeq, now);
  if (dispatch && !read && !withdrawn) {
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

/** Replacing a fallback changes only this ingress's projection, never its
 * original facts or gateway work. Native evaluations are never removed here. */
async function removeDecisionProjection(
  tx: Conn,
  tenant: string,
  user: string,
  event: string,
  dispatch: boolean,
) {
  const [row] = await tx.query(
    'SELECT * FROM notifications WHERE tenant=? AND user=? AND event=?',
    [tenant, user, event],
  );
  if (row) {
    if (row.read_ms === null && Number(row.withdrawn) === 0) {
      await delta(
        tx,
        user,
        String(row.room),
        String(row.thread),
        -1,
        -Number(row.highlight),
        dispatch,
      );
    }
    await tx.execute('DELETE FROM notification_history WHERE seq=?', [
      Number(row.seq),
    ]);
    await tx.execute('DELETE FROM notifications WHERE seq=?', [
      Number(row.seq),
    ]);
  }
  await tx.execute(
    'DELETE FROM push_evaluations WHERE tenant=? AND user=? AND event=?',
    [tenant, user, event],
  );
}

export async function importNotificationOperation(
  tx: Conn,
  operation: RegisterOperation,
  now: number,
  history?: DomainHistoryProof,
) {
  const value = await acceptNotificationOperation(tx, operation, history);
  await reconcileNotificationEvent(tx, value.room, value.event, now);
}

/** The existing server stream owns post-commit consumer wakes, as for imported
 * receipts. Authorization and all retained/projection facts share its attempt. */
export async function receiveNotificationOperation(
  server: Database,
  operation: RegisterOperation,
  authorize: (conn: Conn) => Promise<void>,
  history?: DomainHistoryProof,
) {
  await eventStreamTx(server, async (conn) => {
    await authorize(conn);
    await importNotificationOperation(conn, operation, Date.now(), history);
  });
}

/** Inventory presence cannot prove an empty public history while the selected
 * saved notifying context still awaits receiver evidence. Native evaluations,
 * suppressions and deliberately retired facts keep their ordinary meanings. */
export async function requireNotificationHistory(
  server: Database,
  user: string,
) {
  await server.tx(async (conn) => {
    const keys = await conn.query(
      `SELECT DISTINCT o.semantic_key FROM domain_operations o
       WHERE o.kind='notification' AND o.applied<>-1
       AND json_extract(o.payload_json,'$.user')=?
       AND json_extract(o.payload_json,'$.notify')=1
       AND NOT EXISTS (SELECT 1 FROM notification_retired_users r WHERE r.user=?)
       AND NOT EXISTS (SELECT 1 FROM push_evaluations e
         WHERE e.tenant=json_extract(o.payload_json,'$.tenant')
         AND e.user=? AND e.event=json_extract(o.payload_json,'$.event'))`,
      [user, user, user],
    );
    for (const row of keys) {
      const selected = await selectedNotificationOperation(
        conn,
        String(row.semantic_key),
      );
      if (selected && savedNotification(selected).notify) {
        const value = savedNotification(selected);
        // OOB display is transient. An invite fact without a current display
        // or accepted room event is retained evidence, not a history dependency.
        if (
          value.source === 'invite' && !await notificationTarget(conn, value)
        ) continue;
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'saved notification evidence unavailable',
        );
      }
    }
  });
}

async function notificationTarget(
  tx: Conn,
  value: ReturnType<typeof savedNotification>,
) {
  const [target] = await tx.query(
    "SELECT seq,pos FROM event_index WHERE event=? AND room=? AND standing='accepted' AND grounding='grounded' AND seq IS NOT NULL",
    [value.event, value.room],
  );
  if (target) return target;
  if (value.source !== 'invite') return undefined;
  const [invite] = await tx.query(
    "SELECT seq,seq AS pos FROM prejoin_memberships WHERE room_id=? AND user_id=? AND event_id=? AND kind='invite' AND status='pending'",
    [value.room, value.user, value.event],
  );
  return invite;
}

/** Source facts may precede room evidence. Event projection revisits only the
 * affected identities and assigns local positions; no foreign seq is copied. */
async function projectImportedNotificationEvent(
  tx: Conn,
  room: string,
  event: string,
  now: number,
) {
  const keys = await tx.query(
    "SELECT DISTINCT semantic_key FROM domain_operations WHERE kind='notification' AND json_extract(payload_json,'$.room')=? AND json_extract(payload_json,'$.event')=?",
    [room, event],
  );
  for (const row of keys) {
    const selected = await selectedNotificationOperation(
      tx,
      String(row.semantic_key),
    );
    if (!selected) continue;
    const value = savedNotification(selected);
    if (
      (await tx.query('SELECT 1 FROM notification_retired_users WHERE user=?', [
        value.user,
      ])).length
    ) continue;
    const [prior] = await tx.query(
      'SELECT operation_id,native FROM push_evaluations WHERE tenant=? AND user=? AND event=?',
      [value.tenant, value.user, event],
    );
    // A legacy row is native, not an unproved imported fallback.
    if (
      prior &&
      (Number(prior.native) === 1 ||
        prior.operation_id === selected.operationId)
    ) continue;
    const target = await notificationTarget(tx, value);
    if (!target) continue;
    if (prior) {
      await removeDecisionProjection(
        tx,
        value.tenant,
        value.user,
        event,
        false,
      );
    }
    const seq = Number(target.seq);
    await projectDecision(
      tx,
      room,
      event,
      seq,
      Number(target.pos ?? seq),
      {
        tenant: value.tenant,
        user: value.user,
        ruleRevision: value.ruleRevision,
        ignoreRevision: value.ignoreRevision,
        decision: value.ruleId === null ? null : {
          ruleId: value.ruleId,
          kind: value.ruleKind as PushKind,
          notify: value.notify,
          actions: value.actions,
          highlight: value.highlight,
          tweaks: {},
        },
      },
      now,
      await threadOfEvent(tx, room, event),
      value.source,
      selected.operationId,
      false,
      value.createdMs,
    );
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
