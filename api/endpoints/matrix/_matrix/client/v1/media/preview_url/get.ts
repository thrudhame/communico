import { previewUrl } from '#engine/preview/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const url = request.query.get('url');
  if (url === null || url.length === 0) {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'url is required');
  }
  return await previewUrl(
    context.state.user as string,
    url,
    request.headers.get('Accept-Language'),
  );
}
