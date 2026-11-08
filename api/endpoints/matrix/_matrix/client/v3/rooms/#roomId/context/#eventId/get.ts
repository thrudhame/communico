import { eventContext, roomEventFilterOf } from '#engine/client/timeline.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const limitRaw = request.query.get('limit');
  const limit = limitRaw !== null ? Math.max(0, Number(limitRaw) || 0) : 10;
  let filter = roomEventFilterOf({});
  let lazyLoadMembers = false;
  const raw = request.query.get('filter');
  if (raw !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
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
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    request.params.roomId as string,
    request.params.eventId as string,
    { limit, filter, lazyLoadMembers },
  );
}
