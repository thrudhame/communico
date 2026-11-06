// doltgres publicRooms GET; network selectors are accepted and ignored.
import { publicRooms } from '#engine/client/directory.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const raw = request.query.get('limit');
  const limit = raw === null ? undefined : Number(raw);
  const since = request.query.get('since');
  return await publicRooms({
    limit: limit !== undefined && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : undefined,
    since: since === null ? undefined : since,
  });
}
