import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import type { HttpError } from '@oak/oak';
import { MatrixError } from '../../../../../engine/matrix-error.ts';
import { authorize } from '../../../../../engine/auth.ts';
import { createRoom } from '../../../../../engine/room.ts';
import { SERVER_NAME } from '../../../../../engine/config.ts';

export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  let userId: string;
  try {
    userId = await authorize(request);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }

  let body: { room_version?: unknown } = {};
  try {
    body = await request.body.json();
  } catch {
    body = {};
  }
  // F0: default '11'. Non-string/unknown versions are rejected (never a
  // silent default — Complement 32room-versions); createRoom enforces via
  // the policy registry.
  const roomVersion = body.room_version ?? '11';

  const roomId = '!' + crypto.randomUUID() + ':' + SERVER_NAME;
  try {
    await createRoom(roomId, roomVersion as string, userId);
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    const msg = String(e);
    if (msg.includes('M_UNSUPPORTED_ROOM_VERSION')) {
      return [
        createHttpError(
          Status.BadRequest,
          msg,
        ) as unknown as HttpError<Status.InternalServerError>,
        null,
      ];
    }
    return [createHttpError(Status.InternalServerError, msg), null];
  }
  return [null, { room_id: roomId }];
}
