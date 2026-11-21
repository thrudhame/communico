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
import type { Conn, Database } from '#engine/store/db.ts';
import { isJoined } from '#engine/server/read.ts';
import { integerParameter, invalidParameter } from '#engine/operation.ts';

type Observation = {
  deviceId: string;
  source: string;
  generation: number;
  expiresAt: number;
  receivedMs: number;
};
// Inactive observations retain only their generation fence for this process
// epoch. They are not live users and never become a durable activity backlog.
const typing = new Map<string, Map<string, Map<string, Observation>>>();
const lastChangeT = new Map<string, number>();
let t = 0;
const epoch = crypto.randomUUID();

export type TypingSnapshot = {
  epoch: string;
  seq: number;
  rooms: Map<string, { userIds: string[]; changed: number }>;
};
export type TypingDevice = {
  deviceId: string;
  generation: number;
  // Internal authenticated node identity, never taken from a client body.
  source?: string;
};
export type LiveTypingObservation = {
  roomId: string;
  userId: string;
  deviceId: string;
  generation: number;
  membership: string;
  remainingMs: number;
};

function observationKey(deviceId: string, source = '') {
  return JSON.stringify([source, deviceId]);
}

/** Copy ephemeral values and their cut synchronously, before async rendering.
 * A persisted sliding position must not compare an old process's counter with
 * this process's reset counter. No new durable typing owner is introduced. */
export function captureTyping(rooms: Iterable<string>): TypingSnapshot {
  sweepTyping();
  return {
    epoch,
    seq: t,
    rooms: new Map([...rooms].map((room) => [room, {
      userIds: liveUsers(room),
      changed: lastTypingChange(room),
    }])),
  };
}

// M5b: change listeners for the federation EDU queues (sender.ts).
// Fired on explicit set calls and source-union changes. Expiry is ephemeral by
// nature and the remote's own TTL covers it.
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
  device?: TypingDevice,
  receivedMs = Date.now(),
): Promise<boolean> {
  integerParameter(timeoutMs, 'timeout', 0);
  integerParameter(device?.generation, 'device generation', 0);
  // Serialize admission with the projection's membership transaction. The
  // synchronous memory update cannot land behind its departure reconciliation.
  return await server.tx(async (tx) => {
    if (!await isJoined(tx, roomId, userId)) {
      clearTyping(roomId, userId);
      return false;
    }
    let room = typing.get(roomId);
    if (room === undefined) {
      room = new Map();
      typing.set(roomId, room);
    }
    let observations = room.get(userId);
    if (observations === undefined) {
      observations = new Map();
      room.set(userId, observations);
    }
    const deviceId = device?.deviceId ?? '', source = device?.source ?? '';
    const id = observationKey(deviceId, source);
    const generation = device?.generation ?? 0;
    const held = observations.get(id);
    if (held && held.generation > generation) return true;
    if (held?.generation === generation && held.receivedMs > receivedMs) {
      return true;
    }
    observations.set(id, {
      deviceId,
      source,
      generation,
      expiresAt: isTyping ? receivedMs + (timeoutMs ?? 30000) : 0,
      receivedMs,
    });
    sweepRoom(roomId);
    bump(roomId);
    const active = liveUsers(roomId).includes(userId);
    signalTyping(roomId, userId, active);
    return true;
  });
}

/** Capture only this process's observations at their original membership and
 * remaining lifetime. Imported node observations are never source-local work. */
export async function captureLocalTyping(
  server: Database,
  rooms: Iterable<string>,
): Promise<LiveTypingObservation[]> {
  return await server.tx(async (tx) => {
    const result: LiveTypingObservation[] = [];
    for (const roomId of rooms) {
      sweepRoom(roomId);
      for (const [userId, observations] of typing.get(roomId) ?? []) {
        const local = [...observations.values()].filter((value) =>
          value.source === '' && value.expiresAt > 0
        );
        if (!local.length) continue;
        const [member] = await tx.query(
          "SELECT event FROM memberships WHERE room=? AND user=? AND membership='join'",
          [roomId, userId],
        );
        if (!member) continue;
        for (const value of local) {
          const remainingMs = Math.max(0, value.expiresAt - Date.now());
          if (!remainingMs) continue;
          result.push({
            roomId,
            userId,
            deviceId: value.deviceId,
            generation: value.generation,
            membership: String(member.event),
            remainingMs,
          });
        }
      }
    }
    return result;
  });
}

/** Replace one authenticated node's current view, not a reliable activity tail.
 * The caller composes existing pairing/account/device/room admission. All checks
 * finish before the synchronous memory update under membership serialization. */
export async function replaceTypingSource(
  server: Database,
  source: string,
  values: readonly LiveTypingObservation[],
  elapsed: () => number,
  check: (tx: Conn) => Promise<void>,
): Promise<void> {
  if (!source) invalidParameter('typing source');
  const seen = new Set<string>();
  for (const value of values) {
    if (
      !value.roomId || !value.userId || !value.deviceId || !value.membership
    ) invalidParameter('typing observation');
    if (
      integerParameter(value.generation, 'device generation', 0) ===
        undefined ||
      integerParameter(value.remainingMs, 'remaining typing lifetime', 0) ===
        undefined
    ) invalidParameter('typing observation');
    const key = JSON.stringify([value.roomId, value.userId, value.deviceId]);
    if (seen.has(key)) invalidParameter('duplicate typing observation');
    seen.add(key);
  }
  await server.tx(async (tx) => {
    await check(tx);
    const admitted: LiveTypingObservation[] = [];
    for (const value of values) {
      const [member] = await tx.query(
        "SELECT event FROM memberships WHERE room=? AND user=? AND membership='join'",
        [value.roomId, value.userId],
      );
      if (member?.event === value.membership) admitted.push(value);
    }
    const affected = new Set(values.map((value) => value.roomId));
    for (const [roomId, room] of typing) {
      if (
        [...room.values()].some((observations) =>
          [...observations.values()].some((value) => value.source === source)
        )
      ) affected.add(roomId);
    }
    const before = new Map<string, Set<string>>();
    for (const roomId of affected) {
      sweepRoom(roomId);
      before.set(roomId, new Set(liveUsers(roomId)));
      const room = typing.get(roomId);
      for (const [userId, observations] of room ?? []) {
        for (const [id, value] of observations) {
          if (value.source === source) observations.delete(id);
        }
        if (!observations.size) room!.delete(userId);
      }
      if (room?.size === 0) typing.delete(roomId);
    }
    const age = Math.max(0, elapsed()), now = Date.now();
    for (const value of admitted) {
      const remaining = value.remainingMs - age;
      if (remaining <= 0) continue;
      const room = typing.get(value.roomId) ?? new Map();
      const observations = room.get(value.userId) ?? new Map();
      observations.set(observationKey(value.deviceId, source), {
        source,
        deviceId: value.deviceId,
        generation: value.generation,
        expiresAt: now + remaining,
        receivedMs: now,
      });
      room.set(value.userId, observations);
      typing.set(value.roomId, room);
    }
    for (const roomId of affected) {
      const held = before.get(roomId)!, current = new Set(liveUsers(roomId));
      const changed = [...new Set([...held, ...current])].filter((userId) =>
        held.has(userId) !== current.has(userId)
      );
      if (changed.length) bump(roomId);
      for (const userId of changed) {
        signalTyping(roomId, userId, current.has(userId));
      }
    }
  });
}

function signalTyping(roomId: string, userId: string, active: boolean) {
  for (const listener of [...listeners]) {
    try {
      listener(roomId, userId, active);
    } catch (error) {
      console.error('typing listener error:', error);
    }
  }
}

/** All removal paths share the same stream and federation stop notification. */
function clearTyping(roomId: string, userId: string): void {
  const observations = typing.get(roomId)?.get(userId);
  if (!observations) return;
  typing.get(roomId)!.delete(userId);
  if (typing.get(roomId)?.size === 0) typing.delete(roomId);
  if (![...observations.values()].some((value) => value.expiresAt > 0)) return;
  bump(roomId);
  signalTyping(roomId, userId, false);
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
  for (const roomId of typing.keys()) sweepRoom(roomId);
}

function sweepRoom(roomId: string): void {
  let dropped = false;
  const now = Date.now();
  for (const observations of typing.get(roomId)?.values() ?? []) {
    for (const value of observations.values()) {
      if (value.expiresAt > 0 && value.expiresAt <= now) {
        value.expiresAt = 0;
        dropped = true;
      }
    }
  }
  if (dropped) bump(roomId);
}

function liveUsers(roomId: string): string[] {
  return [...(typing.get(roomId) ?? [])].filter(([, observations]) =>
    [...observations.values()].some((value) => value.expiresAt > 0)
  ).map(([user]) => user);
}

// The live typing set for a room. The sweep runs on read: expired entries
// drop out, and if any were dropped that itself is a change (t bumps —
// §3c), so a syncer waiting since before the expiry sees a fresh
// m.typing with the shrunken list.
export function typingIn(roomId: string): { userIds: string[]; t: number } {
  sweepRoom(roomId);
  return { userIds: liveUsers(roomId), t };
}
