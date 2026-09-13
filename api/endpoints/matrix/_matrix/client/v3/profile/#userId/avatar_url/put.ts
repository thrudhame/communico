import { parseJson } from '@pathfinder/pathfinder/body';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setAvatarUrl } from '#engine/tenant.ts';
import { authorize } from '#engine/auth.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// PUT /_matrix/client/v3/profile/{userId}/avatar_url — "This API sets the
// given user's avatar URL. You must have permission to set this user's
// avatar URL, e.g. you need to have their `access_token`." (spec v1.11,
// Profiles.) Self-only: any other user is 403 M_FORBIDDEN. Body:
// {avatar_url: string|null}; the mxc value is accepted verbatim (foreign
// servers included — no validation beyond string). Response: {}.
export default async function (request: PathfinderRequest) {
  const caller = await authorize(request);
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'cannot set another user\u2019s avatar_url');
  }
  const body = await parseJson(request) as { avatar_url?: unknown };
  if (!('avatar_url' in body) ||
    !(typeof body.avatar_url === 'string' || body.avatar_url === null)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'avatar_url must be a string or null');
  }
  const colon = userId.lastIndexOf(':');
  await setAvatarUrl(serverName(), userId.slice(1, colon), body.avatar_url);
  return {};
}
