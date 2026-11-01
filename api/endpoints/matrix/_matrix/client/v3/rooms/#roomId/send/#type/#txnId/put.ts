import { sendEvent } from '#engine/client/write.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await sendEvent(
    request.params.roomId as string,
    context.state.user as string,
    request.params.type as string,
    await parseJson(request) as Record<string, unknown>,
    (context.state.device as string | undefined) ?? null,
    request.params.txnId as string,
  );
}
