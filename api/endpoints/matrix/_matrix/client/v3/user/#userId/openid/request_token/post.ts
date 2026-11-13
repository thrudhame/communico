import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { parseJson } from '#engine/operation-body.ts';
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { issueOpenIdToken } from '#engine/tenant/openid.ts';

export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  if (caller !== request.params.userId) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'cannot issue tokens for another user',
    );
  }
  const body = await parseJson(request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'object required');
  }
  return await issueOpenIdToken(theApp().tenant, localpartOf(caller));
}
