// Client typing shares the ordinary room admission boundary. The ephemeral
// owner still serializes membership and owns TTLs, notifications and cleanup.
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setTyping, type TypingDevice } from '#engine/typing.ts';
import { lookupRoom } from './room.ts';

export async function setClientTyping(
  roomId: string,
  userId: string,
  typing: boolean,
  timeout?: number,
  device?: TypingDevice,
): Promise<void> {
  if (
    await lookupRoom(roomId) === null ||
    !await setTyping(theApp().server, roomId, userId, typing, timeout, device)
  ) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
}
