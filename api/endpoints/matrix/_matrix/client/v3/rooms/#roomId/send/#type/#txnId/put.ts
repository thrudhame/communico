import { sendEvent } from '#engine/client/write.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
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
    null,
    request.params.txnId as string,
  );
  if (delayed !== null) return delayed;
  return await sendEvent(
    request.params.roomId as string,
    context.state.user as string,
    request.params.type as string,
    content,
    (context.state.device as string | undefined) ?? null,
    request.params.txnId as string,
    context.state.deviceGeneration as number | undefined,
  );
}
