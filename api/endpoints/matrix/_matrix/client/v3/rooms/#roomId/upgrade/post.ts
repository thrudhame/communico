import { MatrixError } from '#engine/matrix-error.ts';
import { upgradeRoom } from '#engine/upgrade.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/rooms/#roomId/upgrade — upgrade the room to a
// new room version (spec v1.16 room_upgrades.yaml; plan D7). new_version
// is required; unknown → 400 M_UNSUPPORTED_ROOM_VERSION; the upgrader
// must be allowed to send m.room.tombstone in the old room → 403.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = (await parseJson(request)) as Record<string, unknown>;
  const newVersion = body.new_version;
  if (typeof newVersion !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'new_version is required');
  }
  const additionalCreators = Array.isArray(body.additional_creators)
    ? (body.additional_creators as unknown[]).filter((x): x is string =>
      typeof x === 'string'
    )
    : [];
  return await upgradeRoom(
    request.params.roomId as string,
    context.state.user as string,
    newVersion,
    additionalCreators,
  );
}
