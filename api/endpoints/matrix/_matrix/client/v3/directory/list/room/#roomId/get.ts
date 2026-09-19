import { getVisibility } from '#engine/directory.ts';

// GET /_matrix/client/v3/directory/list/room/#roomId — the room's
// visibility in the published directory. PUBLIC: no security block on
// this GET (spec v1.16 list_public_rooms.yaml:19-66); the PUT beside it
// is authed (see put.ts).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  return await getVisibility(request.params.roomId as string);
}
