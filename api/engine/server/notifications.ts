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
import {
  graphNotificationRead,
  graphReadClosure,
  graphReceiptsEnabled,
  rememberGraphRead,
} from '#engine/server/receipt-frontier.ts';
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
  if ('user' in scope) {
    // The existing account lifecycle owner calls this once deactivation is
    // durable. Retained facts may still arrive, but cannot recreate its view.
    await tx.execute(
      'INSERT INTO notification_retired_users(user) VALUES(?) ON CONFLICT DO NOTHING',
      [scope.user],
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

/** An edge's arrival or redaction can affect only itself and descendants within
 * the shared classifier's three-hop bound. Reconcile saved decisions, never
 * evaluate history or publish a second alert. All effects share projection's tx. */
export async function reconcileNotificationEvent(
  tx: Conn,
  room: string,
  event: string,
  now: number,
): Promise<void> {
  await projectImportedNotificationEvent(tx, room, event, now);
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
  // Current receipts seed upgrades too; the independent horizons retain the
  // farther position even after a lagging public/private wire update.
  const receipts = await tx.query(
    'SELECT event_ids,thread_id FROM receipts WHERE user_id=? AND room_id=?',
    [input.user, room],
  );
  for (const receipt of dispatch ? receipts : []) {
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
  await projectImportedNotificationEvent(tx, value.room, value.event, now);
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
    const [target] = await tx.query(
      "SELECT seq,pos FROM event_index WHERE event=? AND room=? AND standing='accepted' AND grounding='grounded' AND seq IS NOT NULL",
      [event, room],
    );
    const [invite] = value.source === 'invite'
      ? await tx.query(
        "SELECT seq FROM prejoin_memberships WHERE room_id=? AND user_id=? AND event_id=? AND kind='invite' AND status='pending'",
        [room, value.user, event],
      )
      : [];
    if (!target && !invite) continue;
    if (prior) {
      await removeDecisionProjection(
        tx,
        value.tenant,
        value.user,
        event,
        false,
      );
    }
    const seq = Number(target?.seq ?? invite.seq);
    await projectDecision(
      tx,
      room,
      event,
      seq,
      Number(target?.pos ?? seq),
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
