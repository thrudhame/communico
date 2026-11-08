import { MatrixError } from '#engine/matrix-error.ts';
import { upgradeRoom } from '#engine/client/upgrade.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = await parseJson(request) as Record<string, unknown>;
  if (typeof body.new_version !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'new_version is required');
  }
  const creators = Array.isArray(body.additional_creators)
    ? body.additional_creators.filter((x): x is string => typeof x === 'string')
    : [];
  return await upgradeRoom(
    request.params.roomId as string,
    context.state.user as string,
    body.new_version,
    creators,
  );
}
