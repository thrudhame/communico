// api/engine/visibility.ts — M4 history visibility (plan §3f). Commit 5
// carries readPositionFor (the membership gate + left-user read
// position); canSeeEvent lands with /event and the /messages rewrite.
import { MatrixError } from './matrix-error.ts';
import { membershipOf } from './room.ts';

// Where a user reads the room up to: null (joined: now) or the seq of
// their leave/ban (left users read as of their leave; invitees as of
// their invite). 403 M_FORBIDDEN when the user was never a member (the
// world_readable carve-out lands with canSeeEvent).
export async function readPositionFor(
  userId: string,
  roomId: string,
): Promise<number | null> {
  const m = await membershipOf(roomId, userId);
  if (m === null) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not a member of ' + roomId);
  }
  return m.membership === 'join' ? null : m.seq;
}
