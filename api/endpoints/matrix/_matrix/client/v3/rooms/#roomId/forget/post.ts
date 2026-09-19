import { forget } from '#engine/membership.ts';

// POST /_matrix/client/v3/rooms/#roomId/forget — stop the user
// remembering the room (band C D4; spec v1.16 leaving.yaml:80-126).
// Still-joined → 400 M_UNKNOWN; leave/ban rows (incl. invited-then-left)
// are forgotten; the room then vanishes from initial/full_state syncs and
// 403s on history reads, while an in-window leave event still comes down
// an incremental sync.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  await forget(
    request.params.roomId as string,
    context.state.user as string,
  );
  return {};
}
