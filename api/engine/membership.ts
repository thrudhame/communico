// api/engine/membership.ts — M4 membership operations (plan §3d). Each op
// authors an m.room.member with the right sender/state_key/content and
// ingests it; the rulebook decides authorization (M3). Rulebook rejects
// map to MatrixError(403, 'M_FORBIDDEN'); authorAndIngest holds the room
// lock across author+ingest (E5), so concurrent ops never stale-prev.
import { serverName } from './config.ts';
import { localpartOf } from './auth.ts';
import { authorAndIngest } from './ingest.ts';
import { MatrixError } from './matrix-error.ts';
import { serverDb, withDb } from './db.ts';
import { lookupRoom, membershipOf } from './room.ts';
import { getProfile } from './tenant.ts';

export interface MembershipOpResult {
  roomId: string;
  eventId: string;
  // false when an idempotent op returned the existing event (re-join).
  created: boolean;
}

// Author + ingest the member event (prev_events = the live extremities,
// recomputed per attempt); a rulebook reject surfaces as 403 M_FORBIDDEN,
// never a 500.
async function authorMember(
  roomId: string,
  sender: string,
  stateKey: string,
  content: Record<string, unknown>,
): Promise<MembershipOpResult> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  try {
    const res = await authorAndIngest(roomId, {
      type: 'm.room.member',
      state_key: stateKey,
      sender,
      content,
      origin_server_ts: Date.now(),
    });
    return { roomId, eventId: res.event_id, created: true };
  } catch (e) {
    const msg = String(e);
    if (msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')) {
      throw new MatrixError(403, 'M_FORBIDDEN', msg);
    }
    throw e;
  }
}

// join: sender == state_key == the user; content from the profile
// (displayname/avatar_url) with the request body keys merged on top.
// Already joined -> the existing event, no new one (idempotent re-join).
export async function join(
  roomId: string,
  userId: string,
  extraContent?: Record<string, unknown>,
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, userId);
  if (current?.membership === 'join') {
    return { roomId, eventId: current.eventId, created: false };
  }
  const profile = await getProfile(serverName(), localpartOf(userId));
  const content: Record<string, unknown> = {
    ...(profile?.displayname !== undefined
      ? { displayname: profile.displayname }
      : {}),
    ...(profile?.avatar_url !== undefined
      ? { avatar_url: profile.avatar_url }
      : {}),
    ...(extraContent ?? {}),
    membership: 'join',
  };
  return await authorMember(roomId, userId, userId, content);
}

// leave: self only (sender == state_key). Never a member -> 403.
export async function leave(
  roomId: string,
  userId: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, userId);
  if (current === null) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'never a member of ' + roomId);
  }
  const content: Record<string, unknown> = { membership: 'leave' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, userId, userId, content);
}

const USER_ID_RE = /^@[^:\s]+:[^\s]+$/;

// invite: sender invites the target. Self-invite -> 403; target already
// joined -> 403; malformed target -> 400 M_INVALID_PARAM.
export async function invite(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  if (!USER_ID_RE.test(target)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'not a user id: ' + target);
  }
  if (target === sender) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'cannot invite yourself');
  }
  const current = await membershipOf(roomId, target);
  if (current?.membership === 'join') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      target + ' is already in the room',
    );
  }
  const content: Record<string, unknown> = { membership: 'invite' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}

// ban: sender bans the target (any current membership; the rulebook
// decides — a non-present or under-powered sender gets a 403).
export async function ban(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const content: Record<string, unknown> = { membership: 'ban' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}

// forget (band C D4, spec v1.16 leaving.yaml:80-126): set the forgotten
// flag on the membership row. Still joined → 400 M_UNKNOWN (the spec's
// literal errcode and message shape); leave/ban (incl. the
// invited-then-left row) → forgotten; no row at all → 400 M_UNKNOWN.
// A live invite row is forgotten too: leaving.yaml:91-92 blocks only
// joined users ("they must leave the room before calling this API") —
// the plan enumerates the tested rows; invite is spec-decided here.
// Any later membership event clears the flag (ingest E2).
export async function forget(roomId: string, userId: string): Promise<void> {
  const current = await membershipOf(roomId, userId);
  if (current?.membership === 'join') {
    throw new MatrixError(
      400,
      'M_UNKNOWN',
      `User ${userId} is in room ${roomId}`,
    );
  }
  if (current === null) {
    throw new MatrixError(400, 'M_UNKNOWN', 'no membership to forget');
  }
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE room_membership SET forgotten = TRUE WHERE room_id = $1 AND user_id = $2;',
      [roomId, userId],
    );
  });
}

// kick: a leave authored by someone else. The target must be in the room
// (join/invite/knock) — the spec's auth rules (4.5.4) carry no
// target-membership condition, so this 403 is an op-layer check, as in
// Synapse's REST handler (room_member.py:1027,1044: "The target user is
// not in the room").
export async function kick(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, target);
  if (
    current === null ||
    !['join', 'invite', 'knock'].includes(current.membership)
  ) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'The target user is not in the room',
    );
  }
  const content: Record<string, unknown> = { membership: 'leave' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}
