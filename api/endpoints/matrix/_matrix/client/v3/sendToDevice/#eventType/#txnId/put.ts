import { parseJson } from '@pathfinder/pathfinder/body';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { sendToDevice } from '#engine/client/todevice.ts';
export default async function (request: PathfinderRequest, context: Context) {
  return await sendToDevice(
    context.state.user!,
    context.state.device,
    context.state.deviceGeneration,
    String(request.params.eventType),
    String(request.params.txnId),
    await parseJson(request),
  );
}
