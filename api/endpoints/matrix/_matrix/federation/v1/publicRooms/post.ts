// POST /_matrix/federation/v1/publicRooms — the directory with a filter
// (public_rooms.yaml:156-180); include_all_networks /
// third_party_instance_id accepted and ignored. Auth: the folder's
// 20-auth.ts.
import { publicRooms } from '#engine/directory.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
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
