import { authorize } from '#engine/auth.ts';
import { publicRooms } from '#engine/directory.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// POST /_matrix/client/v3/publicRooms — the directory with a filter.
// AUTH: spec v1.16 list_public_rooms.yaml:170-180 carries a security
// block on POST (GET in this folder has none), so the folder cannot
// carry 20-auth.ts; authorize() is called at file granularity, first
// statement (plan §9's default for spec-mandated mixed folders).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  await authorize(request);
  const body = (await parseJson(request)) as Record<string, unknown>;
  const filter = body.filter as Record<string, unknown> | undefined;
  const search = filter?.generic_search_term;
  const limit = typeof body.limit === 'number'
    ? Math.max(0, body.limit)
    : undefined;
  const since = typeof body.since === 'string' ? body.since : undefined;
  return await publicRooms({
    search: typeof search === 'string' ? search : undefined,
    limit,
    since,
  });
}
