import { relationsPage } from '#engine/client/relations.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
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
    context.state.user as string,
  );
}
