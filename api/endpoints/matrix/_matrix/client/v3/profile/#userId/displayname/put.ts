import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setDisplayName } from '#engine/tenant.ts';
import { authorize } from '#engine/auth.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// PUT /_matrix/client/v3/profile/{userId}/displayname — "This API sets the
// given user's display name. You must have permission to set this user's
// display name, e.g. you need to have their `access_token`." (spec v1.11,
// Profiles.) Self-only: any other user is 403 M_FORBIDDEN. Body:
// {displayname: string|null}; anything else is 400 M_BAD_JSON. Response: {}.
export default async function (request: PathfinderRequest) {
  const caller = await authorize(request);
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'cannot set another user\u2019s displayname',
    );
  }
  const body = await parseJson(request) as { displayname?: unknown };
  if (
    !('displayname' in body) ||
    !(typeof body.displayname === 'string' || body.displayname === null)
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'displayname must be a string or null',
    );
  }
  const colon = userId.lastIndexOf(':');
  await setDisplayName(serverName(), userId.slice(1, colon), body.displayname);
  return {};
}
