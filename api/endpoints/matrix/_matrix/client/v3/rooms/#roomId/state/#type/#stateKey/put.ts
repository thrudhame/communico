import { writeStateKey } from '#engine/client/state.ts';
import { parseJson } from '#engine/operation-body.ts';
import { scheduleDelayed } from '#engine/client/delayed.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const content = await parseJson(request) as Record<string, unknown>;
  const delayed = await scheduleDelayed(
    request,
    context,
    content,
    request.params.stateKey as string,
  );
  if (delayed !== null) return delayed;
  return await writeStateKey(
    request.params.roomId as string,
    context.state.user as string,
    request.params.type as string,
    request.params.stateKey as string,
    content,
  );
}
