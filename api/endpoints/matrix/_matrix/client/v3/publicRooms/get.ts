import { publicRooms } from '#engine/client/directory.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  _context: import('@pathfinder/pathfinder').Context,
) {
  const raw = request.query.get('limit'),
    limit = raw === null ? undefined : Number(raw);
  return await publicRooms({
    limit: limit !== undefined && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : undefined,
    since: request.query.get('since') ?? undefined,
  });
}
