import { redactEvent } from '#engine/client/write.ts';
import { membershipContent } from '#engine/client/membership-request.ts';
import { parseJson } from '#engine/operation-body.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const { reason } = membershipContent(await parseJson(request));
  const res = await redactEvent(
    request.params.roomId as string,
    context.state.user as string,
    request.params.eventId as string,
    reason,
    (context.state.device as string | undefined) ?? null,
    request.params.txnId as string,
    context.state.deviceGeneration as number | undefined,
  );
  return { event_id: res.eventId };
}
