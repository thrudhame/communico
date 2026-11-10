import { relationsPage } from '#engine/client/relations.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await relationsPage(
    request.params.roomId as string,
    request.params.eventId as string,
    { relType: request.params.relType as string },
    {
      dir: request.query.get('dir'),
      limit: request.query.get('limit'),
      from: request.query.get('from'),
      to: request.query.get('to'),
      recurse: request.query.get('recurse'),
    },
    context.state.user as string,
  );
}
