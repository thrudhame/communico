import { decodeSyncRequest } from '#engine/client/sync-request.ts';
import { resolveFilter } from '#engine/tenant/filters.ts';
import { syncFor } from '#engine/syncfeed.ts';
import { theApp } from '#engine/app.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const deviceId = (context.state.device as string | undefined) ?? null;
  const decoded = decodeSyncRequest(request.query);
  const filter = await resolveFilter(
    theApp().tenant,
    userId,
    decoded.filter,
  );
  return await syncFor({
    userId,
    deviceId,
    deviceGeneration: context.state.deviceGeneration,
    ...decoded,
    filter,
  });
}
