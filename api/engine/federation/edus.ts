// api/engine/federation/edus.ts — pending EDUs per destination (D2:
// unpersisted, stale in seconds; a restart loses them and that is
// correct). In-memory queues fed by the change listeners on
// typing/receipts/presence — LOCAL USERS ONLY — coalesced per key: one
// typing state per (room, user), the latest receipt per (room, user),
// the latest presence per user. ≤ 100 ride one transaction; the rest
// wait for the next. The frozen-retry EDU cache lives in sender.ts.
import { serverName } from '#engine/config.ts';

export type Edu = { edu_type: string; content: Record<string, unknown> };

type PresencePush = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ago: number;
  currently_active: boolean;
};
type ReceiptMark = {
  roomId: string;
  userId: string;
  eventId: string;
  ts: number;
  threadId: string | null;
};

const typingQ = new Map<string, Map<string, { seq: number; edu: Edu }>>();
const receiptQ = new Map<
  string,
  Map<string, { seq: number; mark: ReceiptMark }>
>();
const presenceQ = new Map<
  string,
  Map<string, { seq: number; push: PresencePush }>
>();

function localOnly(userId: string): boolean {
  return userId.endsWith(':' + serverName());
}

// Queue entries carry a synchronously-issued seq (last-write-wins): the
// listeners fire synchronously but the destination lookup lands them
// asynchronously, so a stale change must never overwrite a fresh one.
export function queueTyping(
  destination: string,
  roomId: string,
  userId: string,
  typing: boolean,
  seq: number,
): void {
  if (!localOnly(userId)) return;
  let q = typingQ.get(destination);
  if (!q) {
    q = new Map();
    typingQ.set(destination, q);
  }
  const key = roomId + '|' + userId;
  if ((q.get(key)?.seq ?? -1) > seq) return;
  q.set(key, {
    seq,
    edu: {
      edu_type: 'm.typing',
      content: { room_id: roomId, user_id: userId, typing },
    },
  });
}

export function queueReceipt(
  destination: string,
  mark: ReceiptMark,
  seq: number,
): void {
  if (!localOnly(mark.userId)) return;
  let q = receiptQ.get(destination);
  if (!q) {
    q = new Map();
    receiptQ.set(destination, q);
  }
  const key = mark.roomId + '|' + mark.userId;
  if ((q.get(key)?.seq ?? -1) > seq) return;
  q.set(key, { seq, mark });
}

export function queuePresence(
  destination: string,
  push: PresencePush,
  seq: number,
): void {
  if (!localOnly(push.user_id)) return;
  let q = presenceQ.get(destination);
  if (!q) {
    q = new Map();
    presenceQ.set(destination, q);
  }
  if ((q.get(push.user_id)?.seq ?? -1) > seq) return;
  q.set(push.user_id, { seq, push });
}

// Drain up to `limit` EDUs for a destination (the rest stay queued):
// typing as-is; receipts merged into ONE m.receipt (content keyed by
// room, m.receipt.yaml:36-87); presence merged into ONE m.presence push
// list (m.presence.yaml:33-71).
export function drainEdus(destination: string, limit: number): Edu[] {
  const out: Edu[] = [];
  const tq = typingQ.get(destination);
  if (tq) {
    for (const [k, entry] of tq) {
      if (out.length >= limit) break;
      out.push(entry.edu);
      tq.delete(k);
    }
    if (tq.size === 0) typingQ.delete(destination);
  }
  const rq = receiptQ.get(destination);
  if (rq && out.length < limit) {
    const byRoom = new Map<
      string,
      Map<string, { event_ids: string[]; data: Record<string, unknown> }>
    >();
    for (const [k, entry] of rq) {
      const mark = entry.mark;
      let room = byRoom.get(mark.roomId);
      if (!room) {
        room = new Map();
        byRoom.set(mark.roomId, room);
      }
      room.set(mark.userId, {
        event_ids: [mark.eventId],
        data: mark.threadId === null
          ? { ts: mark.ts }
          : { ts: mark.ts, thread_id: mark.threadId },
      });
      rq.delete(k);
    }
    if (rq.size === 0) receiptQ.delete(destination);
    if (byRoom.size > 0) {
      const content: Record<string, unknown> = {};
      for (const [roomId, users] of byRoom) {
        content[roomId] = {
          'm.read': Object.fromEntries(
            [...users.entries()].map(([u, m]) => [u, m]),
          ),
        };
      }
      out.push({ edu_type: 'm.receipt', content });
    }
  }
  const pq = presenceQ.get(destination);
  if (pq && out.length < limit) {
    const push: PresencePush[] = [];
    for (const [k, entry] of pq) {
      push.push(entry.push);
      pq.delete(k);
    }
    if (pq.size === 0) presenceQ.delete(destination);
    if (push.length > 0) {
      out.push({ edu_type: 'm.presence', content: { push } });
    }
  }
  return out;
}

/** Tests simulate a restart: every queue is in-memory (D2). */
export function resetEdusForTests(): void {
  typingQ.clear();
  receiptQ.clear();
  presenceQ.clear();
}

// ---------------------------------------------------------------- inbound --

// Inbound EDUs (§3.3 step 4): dispatch on edu_type; unknown types are
// ignored silently (Synapse federation_server.py:1612-1637) and errors
// in one EDU never fail the transaction (the caller logs and continues).
// EVERY EDU's users must belong to `origin` (typing SS:1085-1088,
// presence SS:1094-1099, receipts SS:1105-1110) or the EDU is ignored.
import { domainOf } from './pdu.ts';
import { membershipOf } from '#engine/room.ts';
import { setTyping } from '#engine/typing.ts';
import { setReceipt } from '#engine/receipts.ts';
import { setPresence } from '#engine/presence.ts';
import { serverDb, withDb } from '#engine/db.ts';

// the remote typing TTL — Synapse's 30 s (typing.py)
const REMOTE_TYPING_TTL_MS = 30_000;

export async function dispatchEdu(origin: string, raw: unknown): Promise<void> {
  const edu = raw as { edu_type?: unknown; content?: unknown };
  const type = typeof edu.edu_type === 'string' ? edu.edu_type : '';
  const content = (edu.content ?? {}) as Record<string, unknown>;
  if (type === 'm.typing') {
    const roomId = typeof content.room_id === 'string' ? content.room_id : null;
    const userId = typeof content.user_id === 'string' ? content.user_id : null;
    if (roomId === null || userId === null) return;
    if (domainOf(userId) !== origin) return; // users belong to origin
    const m = await membershipOf(roomId, userId);
    if (m?.membership !== 'join') return; // joined users only
    setTyping(roomId, userId, content.typing === true, REMOTE_TYPING_TTL_MS);
    return;
  }
  if (type === 'm.receipt') {
    // content: { <roomId>: { 'm.read': { <userId>: { event_ids, data } } } }
    for (const [roomId, perRoom] of Object.entries(content)) {
      const reads = (perRoom as Record<string, unknown>)['m.read'] as
        | Record<string, { event_ids?: unknown; data?: unknown }>
        | undefined;
      if (reads === undefined || typeof reads !== 'object') continue;
      for (const [userId, mark] of Object.entries(reads)) {
        if (domainOf(userId) !== origin) continue;
        const eventIds = Array.isArray(mark.event_ids) ? mark.event_ids : [];
        if (eventIds.length === 0 || typeof eventIds[0] !== 'string') continue;
        const data = (mark.data ?? {}) as { ts?: unknown; thread_id?: unknown };
        await setReceipt(roomId, userId, 'm.read', String(eventIds[0]), {
          ts: typeof data.ts === 'number' ? data.ts : undefined,
          threadId: typeof data.thread_id === 'string' ? data.thread_id : null,
        });
      }
    }
    return;
  }
  if (type === 'm.presence') {
    const push = Array.isArray(content.push) ? content.push : [];
    for (const entry of push) {
      const p = entry as {
        user_id?: unknown;
        presence?: unknown;
        status_msg?: unknown;
        last_active_ago?: unknown;
        currently_active?: unknown;
      };
      if (typeof p.user_id !== 'string' || typeof p.presence !== 'string') {
        continue;
      }
      if (domainOf(p.user_id) !== origin) continue;
      // only for users sharing a room with a local user
      const shares = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          `SELECT 1 FROM room_membership m1
           JOIN room_membership m2 ON m1.room_id = m2.room_id
           WHERE m1.user_id = $1 AND m1.membership = 'join'
             AND m2.membership = 'join' AND m2.user_id LIKE '%:' || $2
           LIMIT 1;`,
          [p.user_id, serverName()],
        );
        return r.rows.length > 0;
      });
      if (!shares) continue;
      await setPresence(
        p.user_id,
        p.presence,
        typeof p.status_msg === 'string' ? p.status_msg : undefined,
        {
          lastActiveAgo: typeof p.last_active_ago === 'number'
            ? p.last_active_ago
            : undefined,
          currentlyActive: p.currently_active === true,
        },
      );
    }
    return;
  }
  // m.device_list_update, m.signing_key_update, m.direct_to_device and
  // anything else: ignored (E2EE milestone), no error
}
