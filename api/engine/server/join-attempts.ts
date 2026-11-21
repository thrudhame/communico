// Persist exact signed work before send_join: an interrupted remote side effect must be undone
// unless the exact join committed to room truth. Active calls are process-local;
// after restart every retained attempt is eligible for reconciliation.
import { MatrixError } from '#engine/matrix-error.ts';
import { openRoom } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import {
  type MembershipAdmission,
  prepareMembershipAdmission,
  setJoinAdmission,
  withMembershipFence,
} from '#engine/room/hooks.ts';
import type { Store } from '#engine/store/index.ts';
import type { Database } from '#engine/store/db.ts';
import type { Pdu } from '#engine/pdu.ts';
import { prejoinLeaveActive, settleSupersededPrejoin } from './prejoin.ts';
import { withProjectionLock } from './project.ts';
import { eventStreamTx } from './stream.ts';

export type JoinAttempt = {
  roomId: string;
  userId: string;
  eventId: string;
  roomVersion: string;
  destination: string;
  addedMs: number;
};
const active = new WeakMap<Store, Map<string, number>>();
function key(a: JoinAttempt): string {
  return JSON.stringify([a.roomId, a.userId, a.eventId]);
}
export function joinAttemptActive(store: Store, a: JoinAttempt): boolean {
  return active.get(store)?.has(key(a)) ?? false;
}
// Caller holds the room authoring lock, outside any room transaction. A pending
// leave must finish before a newer local join can become remotely visible.
async function assertNoJoinCleanup(
  store: Store,
  roomId: string,
  userId: string,
  eventId?: string,
): Promise<void> {
  // Only this live exact attempt may complete through verified resident ingest.
  // Neither another local join nor cold cleanup can borrow its continuation.
  const continuing = eventId !== undefined && active.get(store)?.has(
      JSON.stringify([roomId, userId, eventId]),
    )
    ? eventId
    : null;
  const server = await store.server();
  const result = await withProjectionLock(() => {
    const inflight = prejoinLeaveActive(store, roomId, userId);
    return eventStreamTx(server, async (tx) => {
      if (!inflight) await settleSupersededPrejoin(tx, roomId, userId);
      const rows = await tx.query(
        "SELECT 1 FROM federation_join_attempts WHERE room_id=? AND user_id=? AND remote_refused=0 AND (? IS NULL OR event_id<>? OR join_json IS NULL OR leave_json IS NOT NULL) UNION ALL SELECT 1 FROM prejoin_jobs WHERE room_id=? AND user_id=? AND status IN ('rejecting','failed-retract')",
        [roomId, userId, continuing, continuing, roomId, userId],
      );
      return { inflight, rows };
    });
  });
  if (result.inflight || result.rows.length) {
    throw new MatrixError(
      409,
      'M_BAD_STATE',
      'A remote join cleanup is pending',
    );
  }
}
export function installJoinAdmission(store: Store): void {
  setJoinAdmission(
    store,
    (roomId, userId, eventId) =>
      assertNoJoinCleanup(store, roomId, userId, eventId),
  );
}
export async function beginJoinAttempt(
  store: Store,
  a: JoinAttempt,
  signed: Pdu,
  prepared?: MembershipAdmission,
): Promise<void> {
  if (
    signed.event_id !== a.eventId || signed.room_id !== a.roomId ||
    signed.sender !== a.userId || signed.state_key !== a.userId ||
    signed.type !== 'm.room.member' || signed.content.membership !== 'join'
  ) throw new Error('Join attempt does not match its signed event');
  const admission = prepared ?? await prepareMembershipAdmission(
    store,
    a.roomId,
    a.userId,
    true,
  );
  const json = JSON.stringify(signed);
  installJoinAdmission(store);
  let set = active.get(store);
  if (!set) active.set(store, set = new Map());
  set.set(key(a), (set.get(key(a)) ?? 0) + 1);
  try {
    await withRoomLock(a.roomId, async () => {
      // A concurrent local author may have joined while make_join was in flight.
      // Do not start a remote side effect which could later undo that join.
      let room;
      try {
        room = await openRoom(store, a.roomId);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      if (room !== undefined) {
        const joined = await room.tx(async (tx) => {
          const stay = await tx.segments.latestStay();
          const group = stay === null ? null : await tx.state.current(stay.id);
          const id = group === null
            ? null
            : await tx.state.groupKey(group, 'm.room.member', a.userId);
          const event = id === null ? null : await tx.events.get(id);
          return event !== null &&
            JSON.parse(event.pdu).content?.membership === 'join';
        });
        if (joined) {
          throw new MatrixError(409, 'M_BAD_STATE', 'Already joined locally');
        }
      }
      const server = await store.server();
      await server.tx((tx) =>
        withMembershipFence(admission, tx, async () => {
          await admission?.check?.(tx);
          if (
            (await tx.query(
              'SELECT 1 FROM federation_join_attempts WHERE room_id=? AND user_id=? AND remote_refused=0',
              [a.roomId, a.userId],
            )).length
          ) {
            throw new MatrixError(
              409,
              'M_BAD_STATE',
              'A remote join cleanup is pending',
            );
          }
          await tx.execute(
            'INSERT INTO federation_join_attempts(room_id,user_id,event_id,room_version,destination,added_ms,join_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(room_id,user_id) DO UPDATE SET event_id=excluded.event_id,room_version=excluded.room_version,destination=excluded.destination,added_ms=excluded.added_ms,join_json=excluded.join_json,leave_json=NULL,remote_refused=0 WHERE federation_join_attempts.remote_refused=1',
            [
              a.roomId,
              a.userId,
              a.eventId,
              a.roomVersion,
              a.destination,
              a.addedMs,
              json,
            ],
          );
        })
      );
    });
  } catch (error) {
    releaseJoinAttempt(store, a);
    throw error;
  }
}
export function releaseJoinAttempt(store: Store, a: JoinAttempt): void {
  const set = active.get(store);
  const count = set?.get(key(a)) ?? 0;
  if (count > 1) set!.set(key(a), count - 1);
  else set?.delete(key(a));
}
export async function clearJoinAttempt(
  server: Database,
  a: JoinAttempt,
): Promise<void> {
  await server.execute(
    'DELETE FROM federation_join_attempts WHERE room_id=? AND user_id=? AND event_id=?',
    [a.roomId, a.userId, a.eventId],
  );
}
// Only the typed send_join refusal establishes that no remote membership was
// committed. Persist it before deletion; old/uncertain attempts still owe leave.
export async function refuseJoinAttempt(
  server: Database,
  a: JoinAttempt,
): Promise<void> {
  await server.execute(
    'UPDATE federation_join_attempts SET remote_refused=1 WHERE room_id=? AND user_id=? AND event_id=?',
    [a.roomId, a.userId, a.eventId],
  );
}
export async function joinAttemptRefused(
  server: Database,
  a: JoinAttempt,
): Promise<boolean> {
  return (await server.query(
    'SELECT 1 FROM federation_join_attempts WHERE room_id=? AND user_id=? AND event_id=? AND remote_refused=1',
    [a.roomId, a.userId, a.eventId],
  )).length !== 0;
}
export async function joinLeave(
  server: Database,
  a: JoinAttempt,
): Promise<Pdu | null> {
  const rows = await server.query(
    'SELECT leave_json FROM federation_join_attempts WHERE room_id=? AND user_id=? AND event_id=?',
    [a.roomId, a.userId, a.eventId],
  );
  if (!rows.length) throw new Error('Join cleanup no longer exists');
  return rows[0].leave_json === null
    ? null
    : JSON.parse(String(rows[0].leave_json)) as Pdu;
}
export async function saveJoinLeave(
  server: Database,
  a: JoinAttempt,
  pdu: Pdu,
): Promise<void> {
  const count = await server.execute(
    'UPDATE federation_join_attempts SET leave_json=? WHERE room_id=? AND user_id=? AND event_id=? AND leave_json IS NULL',
    [JSON.stringify(pdu), a.roomId, a.userId, a.eventId],
  );
  if (count !== 1) throw new Error('Join cleanup preparation changed');
}
export async function pendingJoinAttempts(
  server: Database,
): Promise<(JoinAttempt & { signed: Pdu | null })[]> {
  return (await server.query(
    'SELECT * FROM federation_join_attempts ORDER BY added_ms,room_id,user_id',
  )).map((row) => ({
    roomId: String(row.room_id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    roomVersion: String(row.room_version),
    destination: String(row.destination),
    addedMs: Number(row.added_ms),
    // Pre-upgrade attempts retain their original compensation obligation. They
    // cannot acquire invented signed bytes or become a fresh join on recovery.
    signed: row.join_json === null
      ? null
      : JSON.parse(String(row.join_json)) as Pdu,
  }));
}
export async function joinAttemptCommitted(
  store: Store,
  a: JoinAttempt,
): Promise<boolean> {
  try {
    const room = await openRoom(store, a.roomId);
    return await room.tx(async (tx) => {
      const status = await tx.events.getStatus(a.eventId);
      return status?.standing === 'accepted' && status.grounding === 'grounded';
    });
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}
