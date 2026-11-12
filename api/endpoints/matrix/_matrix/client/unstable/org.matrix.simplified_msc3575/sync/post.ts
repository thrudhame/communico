import { config } from '#engine/config.ts';
import { slidingSync } from '#engine/sliding-sync/index.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await slidingSync({
    userId: context.state.user as string,
    deviceId: (context.state.device as string | undefined) ?? null,
    generation: context.state.deviceGeneration,
    request: slidingSyncRequest(
      await parseJson(request),
      request.query,
      config().slidingsync.maxtimeoutms,
    ),
    signal: request._raw.signal,
  });
}
