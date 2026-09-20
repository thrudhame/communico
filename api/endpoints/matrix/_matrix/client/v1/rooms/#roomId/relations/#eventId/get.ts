import { relationsPage } from '#engine/relations.ts';

// GET /_matrix/client/v1/rooms/#roomId/relations/#eventId — all child
// events of the parent (spec v1.16 relations.yaml:19-74).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  return await relationsPage(
    request.params.roomId as string,
    request.params.eventId as string,
    {},
    {
      dir: request.query.get('dir'),
      limit: request.query.get('limit'),
      from: request.query.get('from'),
    },
  );
}
