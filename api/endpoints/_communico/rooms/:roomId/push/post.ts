import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { MatrixError } from '../../../../../engine/matrix-error.ts';
import { pushRoom } from '../../../../../engine/sync.ts';

export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    await authorize(request);
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
  const roomId = decodeURIComponent(request.params.roomId!);
  try {
    await pushRoom(roomId);
    return [null, { ok: true }];
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
