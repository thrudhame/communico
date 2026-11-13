import { parseJson } from '#engine/operation-body.ts';
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setAvatarUrl } from '#engine/tenant/users.ts';
import { propagateProfile } from '#engine/client/membership.ts';
import { authorize } from '#engine/auth-context.ts';
import { localpartOf } from '#engine/ids.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// PUT /_matrix/client/v3/profile/{userId}/avatar_url — "This API sets the
// given user's avatar URL. You must have permission to set this user's
// avatar URL, e.g. you need to have their `access_token`." (spec v1.11,
// Profiles.) Self-only: any other user is 403 M_FORBIDDEN. Body:
// {avatar_url: string}; values are accepted verbatim, as in Synapse. DELETE
// removes the field; no optional MXC validation is imposed. Response: {}.
export default async function (request: PathfinderRequest) {
  const caller = await authorize(request);
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'cannot set another user\u2019s avatar_url',
    );
  }
  const body = await parseJson(request);
  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    typeof (body as Record<string, unknown>).avatar_url !== 'string'
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'avatar_url must be a string',
    );
  }
  await setAvatarUrl(
    theApp().tenant,
    localpartOf(userId),
    (body as { avatar_url: string }).avatar_url,
  );
  await propagateProfile(userId, 'avatar_url');
  return {};
}
