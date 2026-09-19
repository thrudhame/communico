import { publicRooms } from '#engine/directory.ts';

// GET /_matrix/client/v3/publicRooms — the published room directory.
// PUBLIC: no authorize() and no 20-auth.ts here — spec v1.16
// list_public_rooms.yaml:131-169 gives GET no security block (the POST
// in this folder is authed; see post.ts for the mixed-folder note).
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
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
