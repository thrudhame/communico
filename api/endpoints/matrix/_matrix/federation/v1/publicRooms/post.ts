// doltgres publicRooms POST; the shared directory owns filtering/pagination.
import { publicRooms } from '#engine/client/directory.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const body = await parseJson(request) as Record<string, unknown>;
  const filter = body.filter as Record<string, unknown> | undefined;
  const search = filter?.generic_search_term;
  return await publicRooms({
    search: typeof search === 'string' ? search : undefined,
    limit: typeof body.limit === 'number' ? Math.max(0, body.limit) : undefined,
    since: typeof body.since === 'string' ? body.since : undefined,
  });
}
