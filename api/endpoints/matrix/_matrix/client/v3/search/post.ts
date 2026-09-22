import { MatrixError } from '#engine/matrix-error.ts';
import { search, type SearchRoomEvents } from '#engine/search.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/search — room_events search (search.yaml at
// v1.16). Auth is placement (20-auth.ts). Body/search_term shape is
// M_BAD_JSON; order_by and group keys are M_INVALID_PARAM (D12).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  let body: unknown;
  try {
    body = await parseJson(request);
  } catch {
    throw new MatrixError(400, 'M_BAD_JSON', 'body is not valid JSON');
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'body is not an object');
  }
  const cats = (body as Record<string, unknown>).search_categories;
  if (cats === null || typeof cats !== 'object' || Array.isArray(cats)) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'search_categories.room_events.search_term is required',
    );
  }
  const re = (cats as Record<string, unknown>).room_events;
  if (re === null || typeof re !== 'object' || Array.isArray(re)) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'search_categories.room_events.search_term is required',
    );
  }
  const roomEvents = re as Record<string, unknown>;
  if (typeof roomEvents.search_term !== 'string') {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'search_categories.room_events.search_term is required',
    );
  }
  const order = roomEvents.order_by;
  if (
    order !== undefined && order !== 'rank' && order !== 'recent'
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad order_by: ' + order);
  }
  const req: SearchRoomEvents = {
    search_term: roomEvents.search_term,
    keys: roomEvents.keys,
    filter: roomEvents.filter,
    order_by: roomEvents.order_by,
    event_context: roomEvents.event_context,
    include_state: roomEvents.include_state,
    groupings: roomEvents.groupings,
  };
  const room = await search(
    context.state.user as string,
    (context.state.device as string | undefined) ?? null,
    req,
    request.query.get('next_batch'),
  );
  return { search_categories: { room_events: room } };
}
