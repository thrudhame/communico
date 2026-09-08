import type {
  TApiComponentOutcome,
  TApiComponentRequest,
} from '@communico/api/interfaces';
import { createHttpError, Status } from '@oak/oak';
import { authorize } from '../../../../../../engine/auth.ts';
import { MatrixError } from '../../../../../../engine/matrix-error.ts';
import { lookupToken } from '../../../../../../engine/tenant.ts';
import { SERVER_NAME } from '../../../../../../engine/config.ts';

// GET /_matrix/client/v3/account/whoami — matrix-commander validates
// restored credentials with this on every authenticated invocation
// (capture: wire-observed; nio WhoamiResponse requires user_id,
// device_id optional). Unknown/missing tokens are proper 401s (F1).
export default async function (
  request: TApiComponentRequest,
): TApiComponentOutcome {
  try {
    const userId = await authorize(request);
    const header = request.headers.get('Authorization') ?? '';
    const match = /^Bearer (.+)$/.exec(header);
    const token = match?.[1] ?? request.search.get('access_token');
    const info = token ? await lookupToken(SERVER_NAME, token) : null;
    return [null, {
      user_id: userId,
      device_id: info?.device_id ?? undefined,
    }];
  } catch (e) {
    if (e instanceof MatrixError) throw e;
    return [createHttpError(Status.InternalServerError, String(e)), null];
  }
}
