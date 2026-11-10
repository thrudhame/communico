import { authorize } from '#engine/auth-context.ts';
import { publicRooms } from '#engine/client/directory.ts';
import { roomTypesFilter } from '#engine/client/summary.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  await authorize(request);
  const body = await parseJson(request) as Record<string, unknown>,
    filter = body.filter as Record<string, unknown> | undefined;
  return await publicRooms({
    roomTypes: roomTypesFilter(filter?.room_types),
    search: typeof filter?.generic_search_term === 'string'
      ? filter.generic_search_term
      : undefined,
    limit: typeof body.limit === 'number' ? Math.max(0, body.limit) : undefined,
    since: typeof body.since === 'string' ? body.since : undefined,
  });
}
