import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { createRoom } from '../../../../../engine/room.ts';

export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  let userId: string;
  try {
    userId = await authorize(request);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }

  let body: { room_version?: string } = {};
  try {
    body = await request.body.json();
  } catch {
    body = {};
  }
  const roomVersion = body.room_version ?? '10';

  const roomId = '!' + crypto.randomUUID() + ':localhost';
  try {
    await createRoom(roomId, roomVersion, userId);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
  return [null, { room_id: roomId }];
}
