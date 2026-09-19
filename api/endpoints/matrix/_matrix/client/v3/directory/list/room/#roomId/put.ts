import { authorize } from '#engine/auth.ts';
import { setVisibility } from '#engine/directory.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/directory/list/room/#roomId — set the room's
// directory visibility. AUTH: file-level authorize() first statement —
// spec v1.16 list_public_rooms.yaml:76-78 carries security on this PUT
// while the GET beside it is public (mixed folder, plan §9's default).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const userId = await authorize(request);
  const body = (await parseJson(request)) as Record<string, unknown>;
  await setVisibility(
    request.params.roomId as string,
    userId,
    body.visibility as string,
  );
  return {};
}
