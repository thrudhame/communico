// GET /_matrix/federation/v1/publicRooms — the published directory
// (public_rooms.yaml:19-155). Auth: the folder's 20-auth.ts.
// include_all_networks / third_party_instance_id accepted and ignored.
import { publicRooms } from '#engine/directory.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  const limitRaw = request.query.get('limit');
  const limit = limitRaw !== null ? Number(limitRaw) : undefined;
  const since = request.query.get('since') ?? undefined;
  return await publicRooms({
    limit: limit !== undefined && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : undefined,
    since,
  });
}
