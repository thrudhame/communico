import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../../engine/auth.ts';
import { SERVER_NAME } from '../../../../../../engine/config.ts';
import { MatrixError } from '../../../../../../engine/matrix-error.ts';
import { revokeAllTokens } from '../../../../../../engine/tenant.ts';

// POST /_matrix/client/v3/logout/all — invalidate all of the user's tokens.
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    const userId = await authorize(request);
    const localpart = userId.slice(1, userId.lastIndexOf(':'));
    await revokeAllTokens(SERVER_NAME, localpart);
    return [null, {}];
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
