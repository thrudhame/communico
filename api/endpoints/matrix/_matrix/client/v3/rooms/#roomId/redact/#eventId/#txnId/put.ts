import { redactEvent } from '#engine/client/write.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const body = await parseJson(request).catch(() => ({})) as {
    reason?: unknown;
  };
  const reason = typeof body.reason === 'string' ? body.reason : undefined;
  const res = await redactEvent(
    request.params.roomId as string,
    context.state.user as string,
    request.params.eventId as string,
    reason,
    (context.state.device as string | undefined) ?? null,
    request.params.txnId as string,
  );
  return { event_id: res.eventId };
}
