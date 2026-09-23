import { previewUrl } from '#engine/preview/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';

// GET /_matrix/client/v1/media/preview_url — authed-content-repo.yaml:340
// at v1.16. Auth is the parent v1/media/20-auth.ts. `ts` is accepted and
// unused (no cache in this plan).
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
