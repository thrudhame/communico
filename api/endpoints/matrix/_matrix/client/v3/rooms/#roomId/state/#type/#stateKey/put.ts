import { writeStateKey } from '#engine/client/state.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const content = await parseJson(request) as Record<string, unknown>;
  return await writeStateKey(
    request.params.roomId as string,
    context.state.user as string,
    request.params.type as string,
    request.params.stateKey as string,
    content,
  );
}
