import { relationsPage } from '#engine/relations.ts';

// GET /_matrix/client/v1/rooms/#roomId/relations/#eventId/#relType —
// the children relating with the given rel_type (relations.yaml:76-135).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  return await relationsPage(
    request.params.roomId as string,
    request.params.eventId as string,
    { relType: request.params.relType as string },
    {
      dir: request.query.get('dir'),
      limit: request.query.get('limit'),
      from: request.query.get('from'),
    },
  );
}
