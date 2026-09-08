import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../engine/auth.ts';
import { SERVER_NAME } from '../../../../../engine/config.ts';
import { MatrixError } from '../../../../../engine/matrix-error.ts';
import { revokeToken } from '../../../../../engine/tenant.ts';

// POST /_matrix/client/v3/logout — invalidate the calling token.
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    const header = request.headers.get('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1] ?? request.search.get('access_token');
    if (!token) throw new MatrixError(401, 'M_MISSING_TOKEN', 'no Bearer token');
    await authorize(request);
    await revokeToken(SERVER_NAME, token);
    return [null, {}];
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
