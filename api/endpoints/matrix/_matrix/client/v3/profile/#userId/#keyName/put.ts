import { parseJson } from '#engine/operation-body.ts';
import { theApp } from '#engine/app.ts';
import { authorize } from '#engine/auth-context.ts';
import { localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setProfileField } from '#engine/tenant/profiles.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  const caller = await authorize(request);
  const userId = request.params.userId as string;
  if (caller !== userId) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'cannot change another user profile',
    );
  }
  const key = request.params.keyName as string;
  const body = await parseJson(request);
  if (
    body === null || typeof body !== 'object' || Array.isArray(body) ||
    !Object.hasOwn(body, key)
  ) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'profile field required');
  }
  await setProfileField(
    theApp().tenant,
    localpartOf(userId),
    key,
    (body as Record<string, unknown>)[key],
  );
  return {};
}
