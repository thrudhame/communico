import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../../../engine/auth.ts';
import { lookupRoom } from '../../../../../../../engine/room.ts';
import { stateNow } from '../../../../../../../engine/timeline.ts';

export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    await authorize(request);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }

  const roomId = decodeURIComponent(request.params.roomId!);
  try {
    const room = await lookupRoom(roomId);
    if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
    const state = await stateNow(room.dbName);
    return [null, state];
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
