import { notificationsFor } from '#engine/client/notifications.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  return await notificationsFor(
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    request.query,
  );
}
