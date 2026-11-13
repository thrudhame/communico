import { MatrixError } from '#engine/matrix-error.ts';
import { upgradeRoom } from '#engine/client/upgrade.ts';
import { parseJson } from '#engine/operation-body.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const raw = await parseJson(request);
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'upgrade body must be an object');
  }
  const body = raw as Record<string, unknown>;
  return await upgradeRoom(
    request.params.roomId as string,
    context.state.user as string,
    body.new_version,
    body.additional_creators,
  );
}
