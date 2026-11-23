import { notificationsFor } from '#engine/client/notifications.ts';
import { authenticatedDevice } from '#engine/auth-context.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await notificationsFor(
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    request.query,
    request._raw.signal,
    authenticatedDevice(context),
  );
}
