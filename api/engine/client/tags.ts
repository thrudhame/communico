import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { membershipOf } from '#engine/server/read.ts';
import { inviteFor } from '#engine/federation/invites.ts';
import { inviteDeps } from '#engine/client/write.ts';
import { getAccountData, updateRoomTag } from '#engine/tenant/accountdata.ts';
import { localpartOf } from '#engine/tenant/auth.ts';

function ownUser(caller: string, userId: string): void {
  if (caller !== userId) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'tags are private to their owner',
    );
  }
}

export async function tags(caller: string, userId: string, roomId: string) {
  ownUser(caller, userId);
  return await getAccountData(
    theApp().tenant,
    localpartOf(caller),
    roomId,
    'm.tag',
  ) ?? { tags: {} };
}

export async function changeTag(
  caller: string,
  userId: string,
  roomId: string,
  tag: string,
  content?: unknown,
) {
  ownUser(caller, userId);
  if (new TextEncoder().encode(tag).length > 255) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'tag exceeds 255 bytes');
  }
  const app = theApp();
  if (content !== undefined) {
    if (
      content === null || typeof content !== 'object' || Array.isArray(content)
    ) {
      throw new MatrixError(400, 'M_BAD_JSON', 'tag data must be an object');
    }
    const order = (content as Record<string, unknown>).order;
    if (
      order !== undefined &&
      (typeof order !== 'number' || !Number.isFinite(order) || order < 0 ||
        order > 1)
    ) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'tag order must be between 0 and 1',
      );
    }
    if (
      await membershipOf(app.server, roomId, caller) === null &&
      await inviteFor(roomId, caller, inviteDeps()) === null
    ) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'room membership required');
    }
  }
  await updateRoomTag(app.tenant, localpartOf(caller), roomId, tag, content);
  return {};
}
