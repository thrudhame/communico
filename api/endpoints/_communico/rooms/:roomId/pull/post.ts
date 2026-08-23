import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { pullRoom } from '../../../../../engine/sync.ts';

export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    await authorize(request);
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
  const roomId = decodeURIComponent(request.params.roomId!);
  const body = (await request.body.json()) as { remote_url?: string };
  try {
    const n = await pullRoom(roomId, body.remote_url ?? '', true);
    return [null, { new_commits: n }];
  } catch (e) {
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
