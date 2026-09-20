import { MatrixError } from '#engine/matrix-error.ts';
import { threads } from '#engine/relations.ts';
import { parseStreamToken } from '#engine/room.ts';

// GET /_matrix/client/v1/rooms/#roomId/threads — the room's thread
// roots, latest-activity first, with the bundled m.thread aggregation
// (spec v1.16 threads_list.yaml; band C D7/§3f). include=all
// (default) | participated.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const includeRaw = request.query.get('include') ?? 'all';
  if (includeRaw !== 'all' && includeRaw !== 'participated') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'bad include: ' + includeRaw,
    );
  }
  const limitRaw = request.query.get('limit');
  const limit = limitRaw !== null ? Math.max(0, Number(limitRaw) || 0) : 10;
  const from = parseStreamToken(request.query.get('from'));
  return await threads(
    request.params.roomId as string,
    context.state.user as string,
    includeRaw,
    { fromSeq: from?.eSeq ?? null, limit },
  );
}
