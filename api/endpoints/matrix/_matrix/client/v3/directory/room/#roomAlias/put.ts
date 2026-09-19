import { authorize } from '#engine/auth.ts';
import { createAlias } from '#engine/aliases.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/directory/room/#roomAlias — create the mapping.
// AUTH: this folder mixes a PUBLIC get.ts with protected put/delete (spec
// v1.16 directory.yaml — GET at :88-159 carries no security block, PUT
// :23-25 and DELETE :175-177 do), so the folder cannot carry 20-auth.ts;
// authorize() is called at file granularity here, first statement (plan
// §9's default for spec-mandated mixed folders).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const userId = await authorize(request);
  const body = (await parseJson(request)) as Record<string, unknown>;
  const roomId = body.room_id;
  if (typeof roomId !== 'string') {
    return Response.json(
      { errcode: 'M_INVALID_PARAM', error: 'room_id is required' },
      { status: 400 },
    );
  }
  await createAlias(request.params.roomAlias as string, roomId, userId);
  return {};
}
