// api/engine/typing.ts — band C item 3 (D2): typing state is in-process
// (spec typing_notifications.md — ephemeral, never persisted; a restart
// losing it is correct). One process, one listener — a module-level map
// is the whole store.
//
// The global counter t is the typing stream's position (sync token part
// _t<n>); EVERY change bumps it: start, explicit stop (even when the
// user was not typing — §3c), and the expiry sweep (when it drops
// entries). Per-room lastChangeT lets /sync emit m.typing only for rooms
// whose typing moved since the token (§3d).
import type { Database } from '#engine/store/db.ts';
import { isJoined } from '#engine/server/read.ts';

const typing = new Map<string, Map<string, number>>();
const lastChangeT = new Map<string, number>();
let t = 0;

// M5b: change listeners for the federation EDU queues (sender.ts).
// Fired on explicit set calls only — expiry is ephemeral by nature and
// the remote's own TTL covers it.
type TypingListener = (
  roomId: string,
  userId: string,
  isTyping: boolean,
) => void;
const listeners = new Set<TypingListener>();
export function onTypingChange(l: TypingListener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

function bump(roomId: string): void {
  t += 1;
  lastChangeT.set(roomId, t);
}

export function typingSeq(): number {
  return t;
}

export function lastTypingChange(roomId: string): number {
  return lastChangeT.get(roomId) ?? 0;
}

// PUT /rooms/:id/typing/:userId (typing.yaml:22-26): typing=true marks
// the user typing for `timeout` ms (default 30000; 0 = immediate expiry
// — still a registered start, TestTyping's no-room_id case sends it);
// typing=false is an explicit stop and always bumps t.
export async function setTyping(
  server: Database,
  roomId: string,
  userId: string,
  isTyping: boolean,
  timeoutMs?: number,
): Promise<boolean> {
  // Serialize admission with the projection's membership transaction. The
  // synchronous memory update cannot land behind its departure reconciliation.
  return await server.tx(async (tx) => {
    if (!await isJoined(tx, roomId, userId)) {
      clearTyping(roomId, userId);
      return false;
    }
    if (isTyping) {
      const timeout = timeoutMs ?? 30000;
      let room = typing.get(roomId);
      if (room === undefined) {
        room = new Map();
        typing.set(roomId, room);
      }
      room.set(userId, Date.now() + timeout);
    } else {
      typing.get(roomId)?.delete(userId);
    }
    bump(roomId);
    for (const l of listeners) {
      try {
        l(roomId, userId, isTyping);
      } catch (e) {
        console.error('typing listener error:', e);
      }
    }
    return true;
  });
}

/** All removal paths share the same stream and federation stop notification. */
function clearTyping(roomId: string, userId: string): void {
  if (!typing.get(roomId)?.delete(userId)) return;
  if (typing.get(roomId)?.size === 0) typing.delete(roomId);
  bump(roomId);
  for (const listener of listeners) {
    try {
      listener(roomId, userId, false);
    } catch (error) {
      console.error('typing listener error:', error);
    }
  }
}

/** Called after durable projection, including imported resets/removals, before
 * publication listeners wake clients. No endpoint owns membership cleanup. */
export async function reconcileTyping(
  server: Database,
  roomId: string,
): Promise<void> {
  const room = typing.get(roomId);
  if (room === undefined || room.size === 0) return;
  await server.tx(async (tx) => {
    const joined = new Set((await tx.query(
      "SELECT user FROM memberships WHERE room=? AND membership='join'",
      [roomId],
    )).map((row) => String(row.user)));
    for (const user of room.keys()) {
      if (!joined.has(user)) clearTyping(roomId, user);
    }
  });
}

// Sweep every room's expired entries. syncfeed calls this up front, so
// the sync's next_batch _t<n> covers the drops — a sweep mid-construction
// (inside roomTimeline's typingIn read) would land after next_batch was
// computed and make the NEXT sync re-emit the same state.
export function sweepTyping(): void {
  const now = Date.now();
  for (const [roomId, room] of typing) {
    let dropped = false;
    for (const [userId, expiresAt] of room) {
      if (expiresAt <= now) {
        room.delete(userId);
        dropped = true;
      }
    }
    if (dropped) bump(roomId);
  }
}

// The live typing set for a room. The sweep runs on read: expired entries
// drop out, and if any were dropped that itself is a change (t bumps —
// §3c), so a syncer waiting since before the expiry sees a fresh
// m.typing with the shrunken list.
export function typingIn(roomId: string): { userIds: string[]; t: number } {
  const room = typing.get(roomId);
  if (room !== undefined) {
    const now = Date.now();
    let dropped = false;
    for (const [userId, expiresAt] of room) {
      if (expiresAt <= now) {
        room.delete(userId);
        dropped = true;
      }
    }
    if (dropped) bump(roomId);
  }
  return { userIds: [...(typing.get(roomId)?.keys() ?? [])], t };
}
