// Durable presence and receipt streams, shared by client writes and inbound EDUs.
// Counters and rows commit together; notifications only follow a commit.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import type { Row } from '#engine/store/ffi.ts';
import { integerParameter, invalidParameter } from '#engine/operation.ts';
import { readPublicationIdentity } from '#engine/facade/ownership.ts';
import { eventStreamTx } from '#engine/server/stream.ts';
import { isJoined, receiptTargetInThread } from '#engine/server/read.ts';
import { advanceNotificationRead } from '#engine/server/notifications.ts';
import {
  acceptPresenceStatus,
  recordPresenceStatus,
  requirePresenceStatus,
} from '#engine/server/presence-operations.ts';
import type { DomainHistoryProof } from '#engine/facade/domain-control.ts';
import type { RegisterOperation } from '#engine/facade/registers.ts';
import {
  graphReceiptsEnabled,
  receiptFrontier,
} from '#engine/server/receipt-frontier.ts';
import {
  acceptReceiptOperation,
  pendingReceiptOperations,
  type ReceiptOperation,
  receiptOperationMark,
  recordReceiptOperation,
} from '#engine/server/receipt-operations.ts';

const MAX_UNKNOWN_THREADS = 100;
// Synapse's FEDERATION_TIMEOUT: remote liveness expires from authenticated
// receipt, never from the independently reported age of the user's activity.
const REMOTE_PRESENCE_FRESHNESS_MS = 30 * 60 * 1000;
const LOCAL_SYNC_GRACE_MS = 30_000;
const LOCAL_IDLE_MS = 5 * 60 * 1000;
const LOCAL_ACTIVITY_GRANULARITY_MS = 60_000;
export type PresenceDevice = { deviceId: string; generation: number };
export type PresenceSource = { node: string; incarnation: string };
export type LivePresenceObservation = PresenceDevice & {
  userId: string;
  presence: string;
  remainingMs: number;
  lastActiveAgo: number;
};

/** Export only this database's activity, never a projection imported from a
 * different node. An active sync has a bounded fresh observation, not a lease
 * that can outlive the source after disconnection. Explicit status is separate. */
export async function captureLocalPresence(
  server: Db,
): Promise<LivePresenceObservation[]> {
  return await server.tx(async (tx) => {
    const source = await localPresenceIdentity(tx);
    const rows = await tx.query(
      'SELECT * FROM presence_observations WHERE node=? AND incarnation=? ORDER BY user_id,device_id',
      [source.node, source.incarnation],
    );
    const values: LivePresenceObservation[] = [];
    for (const row of rows) {
      const observed = observedPresence(row, server, true);
      if (observed.presence === 'offline') continue;
      values.push({
        userId: String(row.user_id),
        deviceId: String(row.device_id),
        generation: Number(row.generation),
        presence: observed.presence,
        remainingMs: Math.max(0, observed.expiresAt - Date.now()),
        lastActiveAgo: Math.max(0, Date.now() - Number(row.last_active_ms)),
      });
    }
    return values;
  });
}

/** Replace an authenticated source's live view in the existing observation
 * owner. Receiver elapsed time includes admission and writer-queue waits. The
 * callback composes pairing/account/device authority before any row mutation. */
export async function replacePresenceSource(
  server: Db,
  source: PresenceSource,
  values: readonly LivePresenceObservation[],
  elapsed: () => number,
  check: (tx: Conn) => Promise<void>,
): Promise<void> {
  if (!source.node || !source.incarnation) invalidParameter('presence source');
  const seen = new Set<string>();
  for (const value of values) {
    if (
      !value.userId || !value.deviceId ||
      !['online', 'unavailable'].includes(value.presence)
    ) {
      invalidParameter('presence observation');
    }
    for (
      const n of [value.generation, value.remainingMs, value.lastActiveAgo]
    ) {
      if (
        integerParameter(n, 'presence observation', 0) === undefined
      ) invalidParameter('presence observation');
    }
    const key = JSON.stringify([value.userId, value.deviceId]);
    if (seen.has(key)) invalidParameter('duplicate presence observation');
    seen.add(key);
  }
  const changes = await eventStreamTx(server, async (tx) => {
    await check(tx);
    const local = await localPresenceIdentity(tx);
    if (source.node === local.node) invalidParameter('local presence source');
    const held = await tx.query(
      'SELECT DISTINCT user_id FROM presence_observations WHERE node=?',
      [source.node],
    );
    const affected = new Set([
      ...held.map((row) => String(row.user_id)),
      ...values.map((v) => v.userId),
    ]);
    // A currently admitted new incarnation supersedes its own node only. It
    // cannot clear another node or acquire that node's process-local sync lease.
    await tx.execute('DELETE FROM presence_observations WHERE node=?', [
      source.node,
    ]);
    // Monotonic round-trip clocks have fractional milliseconds. Persist integer
    // timestamp evidence, rounding age upward so quantization cannot renew TTL.
    const age = Math.max(0, Math.ceil(elapsed())), now = Date.now();
    for (const value of values) {
      const remaining = value.remainingMs - age;
      if (remaining <= 0) continue;
      await tx.execute(
        'INSERT INTO presence_observations(user_id,node,incarnation,device_id,generation,presence,last_active_ms,last_sync_ms) VALUES(?,?,?,?,?,?,?,?)',
        [
          value.userId,
          source.node,
          source.incarnation,
          value.deviceId,
          value.generation,
          value.presence,
          now - value.lastActiveAgo - age,
          now + remaining - LOCAL_SYNC_GRACE_MS,
        ],
      );
      await tx.execute(
        "INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq,remote_received_ms) VALUES(?,'offline',NULL,0,0,NULL) ON CONFLICT(user_id) DO UPDATE SET remote_received_ms=NULL",
        [value.userId],
      );
    }
    const changes: { userId: string; row: PresenceRow }[] = [];
    for (const userId of affected) {
      const value = await normalizePresence(tx, userId, server);
      if (value.changed) changes.push({ userId, row: value.row });
    }
    return changes;
  });
  for (const change of changes) notify(server, { kind: 'presence', ...change });
}
const syncingDevices = new WeakMap<Db, Map<string, number>>();
function syncDeviceKey(userId: string, device?: PresenceDevice) {
  return JSON.stringify([
    userId,
    device?.deviceId ?? '',
    device?.generation ?? 0,
  ]);
}
/** Protocol identifiers, not arbitrary durable keys. Adapters must not coerce
 * malformed metadata into the distinct unthreaded identity. */
export function receiptThreadId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    (value !== 'main' && !/^\$\S+$/.test(value)) ||
    new TextEncoder().encode(value).length > 255
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid receipt thread_id');
  }
  return value;
}

export type PresenceRow = {
  presence: string;
  statusMsg: string | null;
  lastActiveMs: number;
  seq: number;
};
export type ReceiptRow = {
  userId: string;
  receiptType: 'm.read' | 'm.read.private';
  threadId: string | null;
  eventIds: readonly string[];
  ts: number;
  seq: number;
};
export type EphemeralChange =
  | { kind: 'presence'; userId: string; row: PresenceRow }
  | {
    kind: 'receipt';
    roomId: string;
    receiptType: 'm.read' | 'm.read.private';
    row: ReceiptRow;
  };
const listeners = new Set<(server: Db, change: EphemeralChange) => void>();
export function onEphemeral(
  fn: (server: Db, change: EphemeralChange) => void,
): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function notify(server: Db, change: EphemeralChange): void {
  for (const fn of [...listeners]) {
    try {
      fn(server, change);
    } catch (error) {
      console.error('ephemeral listener error:', error);
    }
  }
}
async function next(tx: Conn, name: string): Promise<number> {
  await tx.execute(
    'INSERT INTO counters(name,value) VALUES(?,0) ON CONFLICT(name) DO NOTHING',
    [name],
  );
  await tx.execute('UPDATE counters SET value=value+1 WHERE name=?', [name]);
  return Number(
    (await tx.query('SELECT value FROM counters WHERE name=?', [name]))[0]
      .value,
  );
}
export async function streamMax(
  server: Db,
  name: 'presence' | 'receipts',
): Promise<number> {
  const rows = await server.query('SELECT value FROM counters WHERE name=?', [
    name,
  ]);
  return rows.length ? Number(rows[0].value) : 0;
}
export async function setPresence(
  server: Db,
  userId: string,
  presence: string,
  statusMsg?: string,
  opts: {
    lastActiveAgo?: number;
    currentlyActive?: boolean;
    remote?: boolean;
    device?: PresenceDevice;
  } = {},
): Promise<void> {
  await writePresence(server, userId, presence, statusMsg ?? null, opts, false);
}

// Refresh private device activity even when the aggregate remains identical;
// the public stream/status must not be rewritten or wake peers for that refresh.
export async function setPresenceValue(
  server: Db,
  userId: string,
  presence: string,
  observation?: PresenceDevice,
): Promise<void> {
  await writePresence(server, userId, presence, undefined, {
    device: observation,
  }, true);
}

async function localPresenceIdentity(tx: Pick<Conn, 'query'>) {
  const source = await readPublicationIdentity(tx);
  // The empty identity is file-local ordinary/unpaired activity, not authority
  // to export an observation. Enrolled exchange requires publication identity.
  return { node: source?.node ?? '', incarnation: source?.incarnation ?? '' };
}

async function observeLocalPresence(
  tx: Conn,
  userId: string,
  presence: string,
  receivedMs: number,
  lastActiveMs: number,
  device?: PresenceDevice,
) {
  const source = await localPresenceIdentity(tx);
  const id = device?.deviceId ?? '', generation = device?.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'bad presence device generation',
    );
  }
  const [held] = await tx.query(
    'SELECT generation,last_active_ms FROM presence_observations WHERE user_id=? AND node=? AND incarnation=? AND device_id=?',
    [userId, source.node, source.incarnation, id],
  );
  if (held && Number(held.generation) > generation) return false;
  const active =
    presence === 'online' || !held || Number(held.generation) !== generation
      ? lastActiveMs
      : Number(held.last_active_ms);
  await tx.execute(
    `INSERT INTO presence_observations(user_id,node,incarnation,device_id,generation,presence,last_active_ms,last_sync_ms) VALUES(?,?,?,?,?,?,?,?)
    ON CONFLICT(user_id,node,incarnation,device_id) DO UPDATE SET generation=excluded.generation,presence=excluded.presence,last_active_ms=excluded.last_active_ms,last_sync_ms=excluded.last_sync_ms`,
    [
      userId,
      source.node,
      source.incarnation,
      id,
      generation,
      presence,
      active,
      receivedMs,
    ],
  );
  return true;
}

async function projectedPresence(
  tx: Pick<Conn, 'query'>,
  userId: string,
  current: Row | undefined,
  server?: Db,
) {
  if (current !== undefined && current.remote_received_ms !== null) {
    return {
      presence: presenceExpired(current) ? 'offline' : String(current.presence),
      lastActiveMs: Number(current.last_active_ms),
    };
  }
  const source = await localPresenceIdentity(tx);
  const rows = await tx.query(
    "SELECT * FROM presence_observations WHERE user_id=? AND ((node=? AND incarnation=?) OR (node<>? AND node<>''))",
    [userId, source.node, source.incarnation, source.node],
  );
  let presence = 'offline', lastActiveMs = Number(current?.last_active_ms ?? 0);
  for (const row of rows) {
    const active = Number(row.last_active_ms);
    lastActiveMs = Math.max(lastActiveMs, active);
    const state = observedPresence(
      row,
      server,
      row.node === source.node && row.incarnation === source.incarnation,
    ).presence;
    if (
      state === 'online' || (state === 'unavailable' && presence === 'offline')
    ) presence = state;
  }
  const previousActivity = Number(current?.last_active_ms ?? 0);
  return {
    presence,
    lastActiveMs: presence !== current?.presence ||
        lastActiveMs - previousActivity >= LOCAL_ACTIVITY_GRANULARITY_MS
      ? lastActiveMs
      : previousActivity,
  };
}

function observedPresence(row: Row, server: Db | undefined, local: boolean) {
  const now = Date.now(), active = Number(row.last_active_ms);
  const syncing = local && server && (syncingDevices.get(server)?.get(
        syncDeviceKey(String(row.user_id), {
          deviceId: String(row.device_id),
          generation: Number(row.generation),
        }),
      ) ?? 0) > 0;
  const expiresAt = syncing
    ? now + LOCAL_SYNC_GRACE_MS
    : (local
      ? Math.max(Number(row.last_sync_ms), active)
      : Number(row.last_sync_ms)) + LOCAL_SYNC_GRACE_MS;
  let presence = String(row.presence);
  if (now > expiresAt) presence = 'offline';
  if (presence === 'online' && now - active > LOCAL_IDLE_MS) {
    presence = 'unavailable';
  }
  return { presence, expiresAt };
}

/** Synapse's user_syncing contract: active requests hold their own device,
 * and the final completed request starts that device's ordinary offline grace.
 * No timer, reliable backlog or independently running presence worker. */
export async function withPresenceSync<T>(
  server: Db,
  userId: string,
  presence: string | undefined,
  device: PresenceDevice | undefined,
  run: () => Promise<T>,
): Promise<T> {
  if (presence === undefined) return await run();
  if (!['online', 'offline', 'unavailable'].includes(presence)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad presence: ' + presence);
  }
  const key = syncDeviceKey(userId, device);
  const syncing = syncingDevices.get(server) ?? new Map<string, number>();
  syncingDevices.set(server, syncing);
  syncing.set(key, (syncing.get(key) ?? 0) + 1);
  try {
    await setPresenceValue(server, userId, presence, device);
    return await run();
  } finally {
    try {
      await eventStreamTx(server, async (tx) => {
        const source = await localPresenceIdentity(tx);
        await tx.execute(
          'UPDATE presence_observations SET last_sync_ms=MAX(last_sync_ms,?) WHERE user_id=? AND node=? AND incarnation=? AND device_id=? AND generation=?',
          [
            Date.now(),
            userId,
            source.node,
            source.incarnation,
            device?.deviceId ?? '',
            device?.generation ?? 0,
          ],
        );
      });
    } finally {
      const count = (syncing.get(key) ?? 1) - 1;
      if (count) syncing.set(key, count);
      else syncing.delete(key);
      if (!syncing.size) syncingDevices.delete(server);
    }
  }
}

async function writePresence(
  server: Db,
  userId: string,
  presence: string,
  statusMsg: string | null | undefined,
  opts: {
    lastActiveAgo?: number;
    currentlyActive?: boolean;
    remote?: boolean;
    device?: PresenceDevice;
  },
  skipUnchanged: boolean,
): Promise<void> {
  if (!['online', 'offline', 'unavailable'].includes(presence)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad presence: ' + presence);
  }
  const receivedMs = Date.now();
  const lastActiveMs = receivedMs - (opts.lastActiveAgo ?? 0);
  const row = await eventStreamTx(server, async (tx) => {
    const [current] = await tx.query('SELECT * FROM presence WHERE user_id=?', [
      userId,
    ]);
    if (
      !opts.remote &&
      !await observeLocalPresence(
        tx,
        userId,
        presence,
        receivedMs,
        lastActiveMs,
        opts.device,
      )
    ) return null;
    const projected = opts.remote
      ? { presence, lastActiveMs }
      : await projectedPresence(
        tx,
        userId,
        current ? { ...current, remote_received_ms: null } : undefined,
        server,
      );
    const status = skipUnchanged
      ? current?.status_msg == null ? null : String(current.status_msg)
      : statusMsg;
    if (!opts.remote && !skipUnchanged) {
      await recordPresenceStatus(tx, userId, status ?? null);
    }
    if (
      skipUnchanged && current?.presence === projected.presence &&
      Number(current.last_active_ms) === projected.lastActiveMs
    ) return null;
    const seq = await next(tx, 'presence');
    await tx.execute(
      `INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq,remote_received_ms) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET presence=excluded.presence,status_msg=excluded.status_msg,last_active_ms=excluded.last_active_ms,seq=excluded.seq,remote_received_ms=excluded.remote_received_ms`,
      [
        userId,
        projected.presence,
        status ?? null,
        projected.lastActiveMs,
        seq,
        opts.remote ? receivedMs : null,
      ],
    );
    return { ...projected, statusMsg: status ?? null, seq };
  });
  if (row === null) return;
  notify(server, { kind: 'presence', userId, row });
}
export async function ensurePresenceRow(
  server: Db,
  userId: string,
): Promise<void> {
  await eventStreamTx(server, async (tx) => {
    if (
      (await tx.query('SELECT 1 FROM presence WHERE user_id=?', [userId]))
        .length
    ) return;
    const seq = await next(tx, 'presence');
    await tx.execute(
      "INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq,remote_received_ms) VALUES(?,'offline',NULL,?,?,NULL)",
      [userId, Date.now(), seq],
    );
  });
}
function presenceExpired(r: Row | undefined): boolean {
  return r !== undefined && r.presence !== 'offline' &&
    r.remote_received_ms !== null &&
    (Number(r.remote_received_ms) === 0 ||
      Date.now() - Number(r.remote_received_ms) >=
        REMOTE_PRESENCE_FRESHNESS_MS);
}

function presenceRow(r: Row | undefined): PresenceRow {
  return r === undefined
    ? { presence: 'offline', statusMsg: null, lastActiveMs: 0, seq: 0 }
    : {
      presence: String(r.presence),
      statusMsg: r.status_msg == null ? null : String(r.status_msg),
      lastActiveMs: Number(r.last_active_ms),
      seq: Number(r.seq),
    };
}

async function normalizePresence(tx: Conn, userId: string, server?: Db) {
  const [current] = await tx.query('SELECT * FROM presence WHERE user_id=?', [
    userId,
  ]);
  const projected = await projectedPresence(tx, userId, current, server);
  if (
    !current ||
    (projected.presence === current.presence &&
      projected.lastActiveMs === Number(current.last_active_ms))
  ) {
    return { row: presenceRow(current), changed: false };
  }
  const seq = await next(tx, 'presence');
  await tx.execute(
    'UPDATE presence SET presence=?,last_active_ms=?,seq=? WHERE user_id=?',
    [projected.presence, projected.lastActiveMs, seq, userId],
  );
  return {
    row: presenceRow({
      ...current,
      presence: projected.presence,
      last_active_ms: projected.lastActiveMs,
      seq,
    }),
    changed: true,
  };
}

export async function getPresence(
  server: Db,
  userId: string,
): Promise<PresenceRow> {
  await requirePresenceStatus(server, userId);
  const [current] = await server.query(
    'SELECT * FROM presence WHERE user_id=?',
    [userId],
  );
  if (!current) return presenceRow(current);
  const projected = await projectedPresence(server, userId, current, server);
  if (
    projected.presence === current.presence &&
    projected.lastActiveMs === Number(current.last_active_ms)
  ) return presenceRow(current);
  // A concurrent authenticated observation wins over a stale reader's expiry.
  const value = await eventStreamTx(
    server,
    (tx) => normalizePresence(tx, userId, server),
  );
  if (value.changed) {
    notify(server, { kind: 'presence', userId, row: value.row });
  }
  return value.row;
}

export async function importPresenceStatus(
  server: Db,
  operation: RegisterOperation,
  check: (conn: Conn) => Promise<void>,
  history?: DomainHistoryProof,
) {
  const change = await eventStreamTx(server, async (tx) => {
    await check(tx);
    const value = await acceptPresenceStatus(tx, operation, history);
    if (!value.available) return null;
    const [current] = await tx.query('SELECT * FROM presence WHERE user_id=?', [
      value.user,
    ]);
    if (current && current.status_msg === value.status) return null;
    const seq = await next(tx, 'presence');
    await tx.execute(
      `INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq,remote_received_ms) VALUES(?,'offline',?,0,?,NULL)
      ON CONFLICT(user_id) DO UPDATE SET status_msg=excluded.status_msg,seq=excluded.seq,remote_received_ms=NULL`,
      [value.user, value.status, seq],
    );
    return {
      userId: value.user,
      row: presenceRow(
        current ? { ...current, status_msg: value.status, seq } : {
          presence: 'offline',
          status_msg: value.status,
          last_active_ms: 0,
          seq,
        },
      ),
    };
  });
  if (change) notify(server, { kind: 'presence', ...change });
}

/** Capture the exact presence view in the sync owner's existing server
 * transaction, BEFORE it captures counters. Rendering cannot publish a lazy
 * expiry after next_batch or mix a newer presence row into an older cut. */
export async function capturePresence(tx: Conn, userId: string, server?: Db) {
  const rows = new Map<string, PresenceRow>();
  const changes: { userId: string; row: PresenceRow }[] = [];
  for (const user of await sharedUsers(tx, userId)) {
    await requirePresenceStatus(tx, user);
    const value = await normalizePresence(tx, user, server);
    rows.set(user, value.row);
    if (value.changed) changes.push({ userId: user, row: value.row });
  }
  return { rows, changes };
}

/** Call only after the capturing transaction commits. A rollback publishes no
 * expiry, stream position or wakeup. The presence owner retains notification. */
export function publishPresence(
  server: Db,
  capture: Awaited<ReturnType<typeof capturePresence>>,
): void {
  for (const change of capture.changes) {
    notify(server, { kind: 'presence', ...change });
  }
}

export async function sharedUsers(
  server: Pick<Conn, 'query'>,
  userId: string,
): Promise<string[]> {
  const rows = await server.query(
    `SELECT DISTINCT b.user FROM memberships a JOIN memberships b ON a.room=b.room
    WHERE a.user=? AND a.membership='join' AND b.membership='join' ORDER BY b.user`,
    [userId],
  );
  return rows.map((r) => String(r.user));
}
export async function setReceipt(
  server: Db,
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  eventId: string,
  opts: {
    ts?: number;
    threadId?: string | null;
    requireRelated?: boolean;
    authorize?: (conn: Conn) => Promise<void>;
  } = {},
): Promise<boolean> {
  return await setReceiptMark(
    server,
    roomId,
    userId,
    receiptType,
    [eventId],
    opts,
  );
}

/** One graph mark, one durable slot and one stream position. Client writes are
 * singleton marks; federation can retain several incomparable extremities. */
export async function setReceiptMark(
  server: Db,
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  targets: readonly string[],
  opts: {
    ts?: number;
    threadId?: string | null;
    requireRelated?: boolean;
    authorize?: (conn: Conn) => Promise<void>;
  } = {},
): Promise<boolean> {
  if (!targets.length || targets.some((id) => typeof id !== 'string')) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'invalid receipt extremities',
    );
  }
  const incoming = [...new Set(targets)].sort();
  const ts = opts.ts ?? Date.now();
  const threadId = receiptThreadId(opts.threadId);
  const admitted = await eventStreamTx(server, async (tx) => {
    await opts.authorize?.(tx);
    if (!await isJoined(tx, roomId, userId)) return null;
    if (threadId !== null && threadId !== 'main') {
      const existing = await tx.query(
        'SELECT 1 FROM receipts WHERE room_id=? AND user_id=? AND receipt_type=? AND thread_id=?',
        [roomId, userId, receiptType, threadId],
      );
      const known = await tx.query(
        'SELECT 1 FROM event_index WHERE room=? AND event=?',
        [roomId, threadId],
      );
      if (!existing.length && !known.length) {
        const pending = await tx.query(
          `SELECT 1 FROM receipts r WHERE room_id=? AND user_id=? AND receipt_type=?
          AND thread_id NOT IN ('','main') AND NOT EXISTS (
            SELECT 1 FROM event_index e WHERE e.room=r.room_id AND e.event=r.thread_id
          ) LIMIT ?`,
          [roomId, userId, receiptType, MAX_UNKNOWN_THREADS],
        );
        if (pending.length >= MAX_UNKNOWN_THREADS) {
          throw new MatrixError(
            429,
            'M_LIMIT_EXCEEDED',
            'unknown receipt thread capacity reached',
          );
        }
      }
    }
    // Local API admission and read effects share the same relation snapshot.
    // Inbound EDUs may reference targets not held yet and retain their identity.
    for (const eventId of incoming) {
      if (
        opts.requireRelated && threadId !== null &&
        !await receiptTargetInThread(tx, roomId, eventId, threadId)
      ) {
        throw new MatrixError(
          400,
          'M_INVALID_PARAM',
          'event_id is not related to the given thread',
        );
      }
    }
    const [membership] = await tx.query(
      'SELECT event FROM memberships WHERE room=? AND user=?',
      [roomId, userId],
    );
    await recordReceiptOperation(tx, {
      roomId,
      userId,
      receiptType,
      eventIds: incoming,
      ts,
      threadId,
      admission: { membershipEvent: String(membership.event) },
    });
    const row = await mergeReceiptMark(
      tx,
      roomId,
      userId,
      receiptType,
      incoming,
      ts,
      threadId,
    );
    await opts.authorize?.(tx);
    // Admission and projection are different outcomes: an unchanged frontier
    // is a successful mark, not a membership rejection.
    return { row };
  });
  if (admitted === null) return false;
  // Private rows wake their owner, but federation only consumes public rows.
  if (admitted.row !== null) {
    notify(server, {
      kind: 'receipt',
      roomId,
      receiptType,
      row: admitted.row,
    });
  }
  return true;
}

/** Shared projection, not admission. Local callers have checked current
 * membership; imported callers retain their original authenticated admission. */
async function mergeReceiptMark(
  tx: Conn,
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  incoming: readonly string[],
  ts: number,
  threadId: string | null,
): Promise<ReceiptRow | null> {
  const [prior] = await tx.query(
    'SELECT event_ids FROM receipts WHERE room_id=? AND user_id=? AND receipt_type=? AND thread_id=?',
    [roomId, userId, receiptType, threadId ?? ''],
  );
  const graph = await graphReceiptsEnabled(tx);
  const now = Date.now();
  const admitRead = async (eventId: string) => {
    if (
      !await advanceNotificationRead(
        tx,
        userId,
        roomId,
        threadId ?? '',
        eventId,
        now,
      )
    ) {
      throw new MatrixError(
        429,
        'M_LIMIT_EXCEEDED',
        'pending receipt capacity reached',
      );
    }
  };
  // Read admission precedes wire-frontier reduction. A retained descendant can
  // be outside this thread, so dropping its valid incoming ancestor must not
  // erase that ancestor's read fact or its immutable transfer intent.
  if (graph) {
    for (const eventId of incoming) await admitRead(eventId);
  }
  const oldIds: string[] = prior ? JSON.parse(String(prior.event_ids)) : [];
  const eventIds = graph
    ? await receiptFrontier(tx, roomId, [...oldIds, ...incoming])
    : incoming;
  if (
    graph && prior &&
    JSON.stringify(oldIds.toSorted()) === JSON.stringify(eventIds)
  ) return null;
  const seq = await next(tx, 'receipts');
  await tx.execute(
    `INSERT INTO receipts(room_id,user_id,receipt_type,thread_id,event_ids,ts_ms,seq) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(room_id,user_id,receipt_type,thread_id) DO UPDATE SET event_ids=excluded.event_ids,ts_ms=excluded.ts_ms,seq=excluded.seq`,
    [
      roomId,
      userId,
      receiptType,
      threadId ?? '',
      JSON.stringify(eventIds),
      ts,
      seq,
    ],
  );
  for (const eventId of eventIds) {
    if (!graph || !incoming.includes(eventId)) await admitRead(eventId);
  }
  return { userId, receiptType, threadId, eventIds, ts, seq };
}

/** Typed-link adapter supplies the authenticated enrolled source AND the
 * selected own-user scope. No public endpoint can nominate either authority. */
export async function importReceiptOperation(
  server: Db,
  operation: ReceiptOperation,
  authenticated: { source: string; incarnation: string; userId: string },
  authorize?: (conn: Conn) => Promise<void>,
  history?: import('#engine/facade/domain-control.ts').DomainHistoryProof,
): Promise<void> {
  const mark = receiptOperationMark(operation);
  if (mark.userId !== authenticated.userId) {
    throw new Error('receipt account not selected');
  }
  const rows = await eventStreamTx(server, async (tx) => {
    await authorize?.(tx);
    await acceptReceiptOperation(tx, operation, authenticated, history);
    return await projectPendingReceipts(tx, mark.roomId);
  });
  for (const row of rows) {
    notify(server, {
      kind: 'receipt',
      roomId: mark.roomId,
      receiptType: row.receiptType,
      row,
    });
  }
}

async function projectPendingReceipts(tx: Conn, roomId: string) {
  const rows: ReceiptRow[] = [];
  for (const operation of await pendingReceiptOperations(tx, roomId)) {
    const mark = receiptOperationMark(operation), visible: string[] = [];
    // Original source admission is immutable. Required receiver evidence may
    // arrive later, including after departure. Missing evidence never ACKs a
    // mark out of storage or discloses an unknown event ID to local consumers.
    if (
      !(await tx.query(
        "SELECT 1 FROM receipt_membership_events m JOIN event_index i ON i.event=m.event AND i.room=m.room WHERE m.event=? AND m.room=? AND m.user=? AND m.membership='join' AND i.standing='accepted' AND i.grounding='grounded'",
        [mark.admission.membershipEvent, roomId, mark.userId],
      )).length
    ) continue;
    for (const event of mark.eventIds) {
      if (
        (await tx.query(
          "SELECT 1 FROM event_index WHERE event=? AND room=? AND standing='accepted' AND grounding='grounded'",
          [event, roomId],
        )).length && (mark.threadId === null ||
          await receiptTargetInThread(tx, roomId, event, mark.threadId))
      ) visible.push(event);
    }
    if (!visible.length) continue;
    const row = await mergeReceiptMark(
      tx,
      roomId,
      mark.userId,
      mark.receiptType,
      visible,
      mark.ts,
      mark.threadId,
    );
    if (row) rows.push(row);
    if (visible.length === mark.eventIds.length) {
      await tx.execute(
        'UPDATE domain_operations SET applied=1 WHERE operation_id=?',
        [operation.operationId],
      );
    }
  }
  return rows;
}

/** Projection has learned new accepted ancestry. Reduce every retained slot in
 * the same server transaction without changing admission or privacy scope. */
export async function reconcileReceiptMarks(
  tx: Conn,
  roomId: string,
): Promise<void> {
  if (!await graphReceiptsEnabled(tx)) return;
  await projectPendingReceipts(tx, roomId);
  const rows = await tx.query(
    'SELECT user_id,receipt_type,thread_id,event_ids FROM receipts WHERE room_id=?',
    [roomId],
  );
  for (const row of rows) {
    const oldIds: string[] = JSON.parse(String(row.event_ids));
    const eventIds = await receiptFrontier(tx, roomId, oldIds);
    if (JSON.stringify(oldIds.toSorted()) === JSON.stringify(eventIds)) {
      continue;
    }
    await tx.execute(
      'UPDATE receipts SET event_ids=?,seq=? WHERE room_id=? AND user_id=? AND receipt_type=? AND thread_id=?',
      [
        JSON.stringify(eventIds),
        await next(tx, 'receipts'),
        roomId,
        String(row.user_id),
        String(row.receipt_type),
        String(row.thread_id),
      ],
    );
  }
}
// Relevance is a publication read too: use the same public-or-own contract for
// long-poll wakeups and incremental room selection as for receipt content.
export async function receiptRoomsSince(
  server: Db,
  userId: string,
  since: number,
): Promise<Set<string>> {
  const rows = await server.query(
    `SELECT DISTINCT room_id FROM receipts WHERE room_id IN (
      SELECT room FROM memberships WHERE user=? AND membership='join'
    ) AND seq>? AND ${VISIBLE_RECEIPTS}`,
    [userId, since, userId],
  );
  return new Set(rows.map((r) => String(r.room_id)));
}

export async function receiptRows(
  server: Pick<Db, 'query'>,
  roomId: string,
  since = 0,
  viewer: string | null = null,
  until = Number.MAX_SAFE_INTEGER,
): Promise<ReceiptRow[]> {
  const rows = await server.query(
    `SELECT * FROM receipts WHERE room_id=? AND seq>? AND seq<=? AND ${VISIBLE_RECEIPTS} ORDER BY seq`,
    [roomId, since, until, viewer],
  );
  return rows.map((r) => ({
    userId: String(r.user_id),
    receiptType: String(r.receipt_type) as ReceiptRow['receiptType'],
    threadId: r.thread_id === '' ? null : String(r.thread_id),
    eventIds: JSON.parse(String(r.event_ids)) as string[],
    ts: Number(r.ts_ms),
    seq: Number(r.seq),
  }));
}
export async function receiptsSince(
  server: Pick<Db, 'query'>,
  roomId: string,
  viewer: string,
  since: number,
): Promise<Record<string, unknown>[]> {
  const rows = await receiptRows(server, roomId, since, viewer);
  return receiptContents(rows);
}

/** One set-based capture for all the viewer's membership rooms. The caller
 * supplies the same transaction that owns membership, counts and maxima. */
export async function receiptSnapshot(
  server: Pick<Db, 'query'>,
  viewer: string,
  since: number,
): Promise<Map<string, Record<string, unknown>[]>> {
  const rows = await server.query(
    `SELECT r.* FROM receipts r WHERE seq>? AND ${VISIBLE_RECEIPTS}
    AND EXISTS (SELECT 1 FROM memberships m WHERE m.room=r.room_id AND m.user=?) ORDER BY seq`,
    [since, viewer, viewer],
  );
  const rooms = new Map<string, ReceiptRow[]>();
  for (const r of rows) {
    const room = String(r.room_id);
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room)!.push({
      userId: String(r.user_id),
      receiptType: String(r.receipt_type) as ReceiptRow['receiptType'],
      threadId: r.thread_id === '' ? null : String(r.thread_id),
      eventIds: JSON.parse(String(r.event_ids)) as string[],
      ts: Number(r.ts_ms),
      seq: Number(r.seq),
    });
  }
  return new Map([...rooms].map(([id, marks]) => [id, receiptContents(marks)]));
}

type ReceiptContent = Record<string, Record<string, Record<string, unknown>>>;

function putReceipt(
  content: ReceiptContent,
  row: ReceiptRow,
  eventId: string,
): void {
  content[eventId] ??= {};
  content[eventId][row.receiptType] ??= {};
  content[eventId][row.receiptType][row.userId] = {
    ts: row.ts,
    ...(row.threadId === null ? {} : { thread_id: row.threadId }),
  };
}

/** Single-event MSC4102 wire map: unthreaded wins a colliding slot, while
 * representable threaded slots retain their identity. Durable rows stay intact;
 * ordinary sync can still emit all slots as separate per-thread events. */
export function receiptContent(rows: ReceiptRow[]): ReceiptContent {
  const content: ReceiptContent = {};
  for (const row of rows) {
    for (const eventId of row.eventIds) {
      const previous = content[eventId]?.[row.receiptType]?.[row.userId] as {
        thread_id?: string;
      } | undefined;
      if (
        row.threadId !== null && previous && previous.thread_id === undefined
      ) {
        continue;
      }
      putReceipt(content, row, eventId);
    }
  }
  return content;
}

function receiptContents(rows: ReceiptRow[]): Record<string, unknown>[] {
  // Batch separately by thread: the wire map cannot hold both an unthreaded
  // and a main receipt at the same event/type/user key in one event.
  const threads = new Map<string | null, ReceiptContent>();
  for (const row of rows) {
    let content = threads.get(row.threadId);
    if (content === undefined) {
      content = {};
      threads.set(row.threadId, content);
    }
    for (const eventId of row.eventIds) putReceipt(content, row, eventId);
  }
  return [...threads.values()];
}

// One visibility predicate for payloads and long-poll relevance. The default
// null viewer in receiptRows is the public-only federation reader.
const VISIBLE_RECEIPTS =
  "(receipt_type='m.read' OR (receipt_type='m.read.private' AND user_id=?))";
