import { MatrixError } from '#engine/matrix-error.ts';
import { threads } from '#engine/client/relations.ts';
import { parseStreamToken } from '#engine/client/timeline.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const include = request.query.get('include') ?? 'all';
  if (include !== 'all' && include !== 'participated') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad include: ' + include);
  }
  const raw = request.query.get('limit'),
    limit = raw === null ? 10 : Math.max(0, Number(raw) || 0),
    from = parseStreamToken(request.query.get('from'));
  return await threads(
    request.params.roomId as string,
    context.state.user as string,
    include,
    { fromSeq: from?.eSeq ?? null, limit },
  );
}
