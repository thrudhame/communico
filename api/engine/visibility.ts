// api/engine/visibility.ts — M4 history visibility (plan §3f). Commit 5
// carried readPositionFor (the membership gate + left-user read
// position); commit 9 adds canSeeEvent per the spec's history_visibility
// module (content/client-server-api/modules/history_visibility.md at
// v1.16 — the server-behaviour rules are transcribed in canSeeEvent).
import { MatrixError } from './matrix-error.ts';
import { membershipOf, stateAtSeq } from './room.ts';

// Where a user reads the room up to: null (joined: now) or the seq of
// their leave/ban (left users read as of their leave; invitees as of
// their invite). 403 M_FORBIDDEN when the user was never a member (the
// world_readable carve-out lands with canSeeEvent) — and when the room
// is forgotten (band C D4: forget hides history; leaving.yaml:86-89 "a
// user will no longer be able to retrieve history for this room").
export async function readPositionFor(
  userId: string,
  roomId: string,
): Promise<number | null> {
  const m = await membershipOf(roomId, userId);
  if (m === null) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not a member of ' + roomId);
  }
  if (m.forgotten) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'room forgotten: ' + roomId);
  }
  return m.membership === 'join' ? null : m.seq;
}

// Spec server behaviour (history_visibility.md at v1.16), evaluated with
// the state AT THE EVENT (E1): hv = the history_visibility in state at
// the event (default shared); m = the viewer's membership in state at the
// event.
//   1. hv == world_readable -> allow.
//   2. m == join -> allow.
//   3. hv == shared and the user joined the room at any point after the
//      event -> allow (plan §3f's form: a current-or-past membership row
//      exists at all).
//   4. m == invite and hv == invited -> allow.
//   5. otherwise deny.
// Plus the module's own-membership carve-out: a user always sees their
// own m.room.member events.
export async function canSeeEvent(
  userId: string,
  roomId: string,
  event: { seq: number; type: string; stateKey?: string },
): Promise<boolean> {
  if (event.type === 'm.room.member' && event.stateKey === userId) {
    return true;
  }
  const state = (await stateAtSeq(roomId, event.seq)) ?? [];
  const hvRow = state.find((r) => r.type === 'm.room.history_visibility');
  const hv = ((hvRow?.content ?? {}) as { history_visibility?: string })
    .history_visibility ?? 'shared';
  if (hv === 'world_readable') return true;
  const mRow = state.find((r) =>
    r.type === 'm.room.member' && r.stateKey === userId
  );
  const m = ((mRow?.content ?? {}) as { membership?: string }).membership;
  if (m === 'join') return true;
  if (hv === 'shared') {
    return (await membershipOf(roomId, userId)) !== null;
  }
  if (hv === 'invited') return m === 'invite';
  return false; // hv == 'joined' (or unknown): m == join was the only allow
}
