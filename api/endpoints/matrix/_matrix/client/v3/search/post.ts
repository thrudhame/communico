import { MatrixError } from '#engine/matrix-error.ts';
import { search, type SearchRoomEvents } from '#engine/client/search.ts';
import { parseJson } from '#engine/operation-body.ts';
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
  const bad = () =>
    new MatrixError(
      400,
      'M_BAD_JSON',
      'search_categories.room_events.search_term is required',
    );
  if (cats === null || typeof cats !== 'object' || Array.isArray(cats)) {
    throw bad();
  }
  const re = (cats as Record<string, unknown>).room_events;
  if (re === null || typeof re !== 'object' || Array.isArray(re)) throw bad();
  const events = re as Record<string, unknown>;
  if (typeof events.search_term !== 'string') throw bad();
  if (
    events.order_by !== undefined && events.order_by !== 'rank' &&
    events.order_by !== 'recent'
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'bad order_by: ' + events.order_by,
    );
  }
  const req: SearchRoomEvents = {
    search_term: events.search_term,
    keys: events.keys,
    filter: events.filter,
    order_by: events.order_by,
    event_context: events.event_context,
    include_state: events.include_state,
    groupings: events.groupings,
  };
  return {
    search_categories: {
      room_events: await search(
        context.state.user as string,
        (context.state.device as string | undefined) ?? null,
        req,
        request.query.get('next_batch'),
      ),
    },
  };
}
