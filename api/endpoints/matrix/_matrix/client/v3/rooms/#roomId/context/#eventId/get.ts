import { eventContext } from '#engine/context.ts';
import { roomEventFilterOf } from '#engine/filters.ts';
import { MatrixError } from '#engine/matrix-error.ts';

// GET /_matrix/client/v3/rooms/#roomId/context/#eventId —
// event_context.yaml at v1.16. limit defaults to 10 (yaml:49-55);
// filter is inline RoomEventFilter JSON (yaml:59-67). Auth is the
// parent rooms/20-auth.ts.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const eventId = request.params.eventId as string;
  const limitRaw = request.query.get('limit');
  const limit = limitRaw !== null ? Math.max(0, Number(limitRaw) || 0) : 10;
  let filter = roomEventFilterOf({});
  let lazyLoadMembers = false;
  const filterRaw = request.query.get('filter');
  if (filterRaw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(filterRaw);
    } catch {
      throw new MatrixError(400, 'M_BAD_JSON', 'filter is not valid JSON');
    }
    filter = roomEventFilterOf(parsed);
    if (
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ) {
      lazyLoadMembers =
        (parsed as Record<string, unknown>).lazy_load_members === true;
    }
  }
  return await eventContext(
    userId,
    (context.state.device as string | undefined) ?? null,
    roomId,
    eventId,
    { limit, filter, lazyLoadMembers },
  );
}
