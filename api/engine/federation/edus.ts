// api/engine/federation/edus.ts — EDUs both ways (old D2).
//
// OUTGOING: per-destination queues fed by the producers (typing today;
// receipts/presence when stage 5 lands theirs) — LOCAL USERS ONLY (the
// injected predicate) — coalesced per key: one typing state per
// (room, user), the latest receipt per (room, user), the latest presence
// per user. ≤ 100 ride one transaction; the rest wait for the next.
// Unpersisted, stale in seconds; a restart loses them and that is
// correct. The frozen-retry EDU cache lives in sender.ts. Per-instance
// queues (the old module globals served the one global database).
//
// INBOUND: dispatch on edu_type through the registered handlers; unknown
// types are ignored silently (Synapse federation_server.py:1612-1637)
// and errors in one EDU never fail the transaction (the caller logs and
// continues). EVERY EDU's users must belong to `origin` (typing
// SS:1085-1088, presence SS:1094-1099, receipts SS:1105-1110) or the EDU
// is ignored. The handlers are in-memory (plan §2 row 5): typing rides
// the kept in-process typing module, receipts/presence are per-instance
// maps; the durable tables are stage 5's.
import { membershipOf } from '#engine/server/read.ts';
import type { Db } from '#engine/store/db.ts';
import { setTyping, typingIn } from '#engine/typing.ts';
import { domainOf } from './pdu.ts';

export type Edu = { edu_type: string; content: Record<string, unknown> };

export type PresencePush = {
  user_id: string;
  presence: string;
  status_msg: string | null;
  last_active_ago: number;
  currently_active: boolean;
};

export type ReceiptMark = {
  roomId: string;
  userId: string;
  eventId: string;
  ts: number;
  threadId: string | null;
};

// --- outgoing ----------------------------------------------------------------

export type EduQueues = {
  queueTyping(
    destination: string,
    roomId: string,
    userId: string,
    typing: boolean,
    seq: number,
  ): void;
  queueReceipt(destination: string, mark: ReceiptMark, seq: number): void;
  queuePresence(destination: string, push: PresencePush, seq: number): void;
  drain(destination: string, limit: number): Edu[];
};

// The queues for one instance. Queue entries carry a synchronously-issued
// seq (last-write-wins): the producers fire synchronously but the
// destination lookup lands them asynchronously, so a stale change must
// never overwrite a fresh one. `wake`, when given, fires on every
// accepted queue (the sender's public wake — an EDU-only batch rides the
// next /send).
export function eduQueues(
  isLocal: (userId: string) => boolean,
  wake?: (destination: string) => void,
): EduQueues {
  const typingQ = new Map<string, Map<string, { seq: number; edu: Edu }>>();
  const receiptQ = new Map<
    string,
    Map<string, { seq: number; mark: ReceiptMark }>
  >();
  const presenceQ = new Map<
    string,
    Map<string, { seq: number; push: PresencePush }>
  >();

  function queueTyping(
    destination: string,
    roomId: string,
    userId: string,
    typing: boolean,
    seq: number,
  ): void {
    if (!isLocal(userId)) return;
    let q = typingQ.get(destination);
    if (q === undefined) {
      q = new Map();
      typingQ.set(destination, q);
    }
    const key = roomId + '|' + userId;
    const seen = q.get(key);
    if (seen !== undefined && seen.seq > seq) return;
    q.set(key, {
      seq,
      edu: {
        edu_type: 'm.typing',
        content: { room_id: roomId, user_id: userId, typing },
      },
    });
    if (wake !== undefined) wake(destination);
  }

  function queueReceipt(
    destination: string,
    mark: ReceiptMark,
    seq: number,
  ): void {
    if (!isLocal(mark.userId)) return;
    let q = receiptQ.get(destination);
    if (q === undefined) {
      q = new Map();
      receiptQ.set(destination, q);
    }
    const key = mark.roomId + '|' + mark.userId;
    const seen = q.get(key);
    if (seen !== undefined && seen.seq > seq) return;
    q.set(key, { seq, mark });
    if (wake !== undefined) wake(destination);
  }

  function queuePresence(
    destination: string,
    push: PresencePush,
    seq: number,
  ): void {
    if (!isLocal(push.user_id)) return;
    let q = presenceQ.get(destination);
    if (q === undefined) {
      q = new Map();
      presenceQ.set(destination, q);
    }
    const seenPush = q.get(push.user_id);
    if (seenPush !== undefined && seenPush.seq > seq) return;
    q.set(push.user_id, { seq, push });
    if (wake !== undefined) wake(destination);
  }

  // Drain up to `limit` EDUs for a destination (the rest stay queued):
  // typing as-is; receipts merged into ONE m.receipt (content keyed by
  // room, m.receipt.yaml:36-87); presence merged into ONE m.presence
  // push list (m.presence.yaml:33-71).
  function drain(destination: string, limit: number): Edu[] {
    const out: Edu[] = [];
    const tq = typingQ.get(destination);
    if (tq !== undefined) {
      for (const [k, entry] of tq) {
        if (out.length >= limit) break;
        out.push(entry.edu);
        tq.delete(k);
      }
      if (tq.size === 0) typingQ.delete(destination);
    }
    const rq = receiptQ.get(destination);
    if (rq !== undefined && out.length < limit) {
      const byRoom = new Map<
        string,
        Map<string, { event_ids: string[]; data: Record<string, unknown> }>
      >();
      for (const [k, entry] of rq) {
        const mark = entry.mark;
        let room = byRoom.get(mark.roomId);
        if (room === undefined) {
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
    if (pq !== undefined && out.length < limit) {
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

  return { queueTyping, queueReceipt, queuePresence, drain };
}

// --- inbound -----------------------------------------------------------------

// the remote typing TTL — Synapse's 30 s (typing.py)
const REMOTE_TYPING_TTL_MS = 30_000;

export type EduHandler = (
  origin: string,
  content: Record<string, unknown>,
) => Promise<void>;

export type EduState = {
  dispatch(origin: string, raw: unknown): Promise<void>;
  register(type: string, handler: EduHandler): void;
  // the in-memory reads (tests and — stage 5 — the /sync assembly)
  typingOf(roomId: string): { userIds: string[] };
  presenceOf(userId: string): PresencePush | null;
  receiptsIn(
    roomId: string,
  ): { userId: string; eventId: string; ts: number; threadId: string | null }[];
};

// The inbound state of one instance: the handlers (typing/receipts/
// presence built in; device list and anything else ignored — the old
// stubs) and the in-memory receipt/presence maps. `self` is our server
// name (the shares-room check's local side).
export function eduState(server: Db, self: string): EduState {
  const receipts = new Map<
    string,
    Map<string, { eventId: string; ts: number; threadId: string | null }>
  >();
  const presence = new Map<string, PresencePush>();
  const handlers = new Map<string, EduHandler>();

  handlers.set('m.typing', async (origin, content) => {
    const roomId = typeof content.room_id === 'string' ? content.room_id : null;
    const userId = typeof content.user_id === 'string' ? content.user_id : null;
    if (roomId === null || userId === null) return;
    if (domainOf(userId) !== origin) return; // users belong to origin
    const m = await membershipOf(server, roomId, userId);
    if (m === null || m.membership !== 'join') return; // joined users only
    setTyping(roomId, userId, content.typing === true, REMOTE_TYPING_TTL_MS);
  });

  handlers.set('m.receipt', (origin, content) => {
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
        const data = (mark.data == null ? {} : mark.data) as {
          ts?: unknown;
          thread_id?: unknown;
        };
        let room = receipts.get(roomId);
        if (room === undefined) {
          room = new Map();
          receipts.set(roomId, room);
        }
        room.set(userId, {
          eventId: String(eventIds[0]),
          ts: typeof data.ts === 'number' ? data.ts : Date.now(),
          threadId: typeof data.thread_id === 'string' ? data.thread_id : null,
        });
      }
    }
    return Promise.resolve();
  });

  handlers.set('m.presence', async (origin, content) => {
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
      const shares = await server.query(
        `SELECT 1 FROM memberships m1
         JOIN memberships m2 ON m1.room = m2.room
         WHERE m1.user = ? AND m1.membership = 'join'
           AND m2.membership = 'join' AND m2.user LIKE '%:' || ?
         LIMIT 1`,
        [p.user_id, self],
      );
      if (shares.length === 0) continue;
      presence.set(p.user_id, {
        user_id: p.user_id,
        presence: p.presence,
        status_msg: typeof p.status_msg === 'string' ? p.status_msg : null,
        last_active_ago: typeof p.last_active_ago === 'number'
          ? p.last_active_ago
          : 0,
        currently_active: p.currently_active === true,
      });
    }
  });

  return {
    dispatch: async (origin, raw) => {
      const edu = raw as { edu_type?: unknown; content?: unknown };
      const type = typeof edu.edu_type === 'string' ? edu.edu_type : '';
      const content = (edu.content == null ? {} : edu.content) as Record<
        string,
        unknown
      >;
      const handler = handlers.get(type);
      if (handler === undefined) return; // unknown types ignored silently
      await handler(origin, content);
    },
    register: (type, handler) => {
      handlers.set(type, handler);
    },
    typingOf: (roomId) => ({ userIds: typingIn(roomId).userIds }),
    presenceOf: (userId) => {
      const p = presence.get(userId);
      return p === undefined ? null : p;
    },
    receiptsIn: (roomId) => {
      const room = receipts.get(roomId);
      if (room === undefined) return [];
      return [...room.entries()].map(([userId, mark]) => ({
        userId,
        eventId: mark.eventId,
        ts: mark.ts,
        threadId: mark.threadId,
      }));
    },
  };
}
