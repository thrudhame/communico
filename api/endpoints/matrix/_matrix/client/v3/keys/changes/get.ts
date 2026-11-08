import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { keyChanges } from '#engine/client/device-lists.ts';

export default async function (request: PathfinderRequest, context: Context) {
  const query = request.query;
  return await keyChanges(
    context.state.user!,
    query.get('from'),
    query.get('to'),
  );
}
