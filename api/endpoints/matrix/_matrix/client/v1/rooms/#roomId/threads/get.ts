import { MatrixError } from '#engine/matrix-error.ts';
import { relationLimit, threads } from '#engine/client/relations.ts';
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const include = request.query.get('include') ?? 'all';
  if (include !== 'all' && include !== 'participated') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad include: ' + include);
  }
  const limit = relationLimit(request.query.get('limit'));
  return await threads(
    request.params.roomId as string,
    context.state.user as string,
    include,
    { from: request.query.get('from'), limit },
  );
}
