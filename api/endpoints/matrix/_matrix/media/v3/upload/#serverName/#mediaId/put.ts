import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/auth.ts';
import { getMedia, markUploaded } from '#engine/tenant.ts';
import { assertLocalMxc, storeUploadBody } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// PUT /_matrix/media/v3/upload/{serverName}/{mediaId} — "Upload content
// to an mxc:// URI that was created earlier." (spec v1.16, added v1.7,
// https://spec.matrix.org/v1.16/client-server-api/#put_matrixmediav3uploadservernamemediaid)
// 404 M_NOT_FOUND for foreign or unknown ids ("The MXC ID was not created
// with POST /_matrix/media/v1/create"), 403 M_FORBIDDEN for a different
// user than the creator ("The request comes from a different user than
// the one that called POST /_matrix/media/v1/create"), 409
// M_CANNOT_OVERWRITE_MEDIA when the id already has content. Auth: folder
// middleware on media/v3/upload/.
export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const mxcServerName = request.params.serverName as string;
  const mediaId = request.params.mediaId as string;
  assertLocalMxc(mxcServerName, mediaId);
  const row = await getMedia(serverName(), mediaId);
  if (row === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'Unknown media ID');
  }
  if (row.localpart !== localpartOf(caller)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'Media belongs to a different user',
    );
  }
  if (row.state === 'uploaded') {
    throw new MatrixError(
      409,
      'M_CANNOT_OVERWRITE_MEDIA',
      'Media already uploaded',
    );
  }
  const contentType = request.headers.get('Content-Type') ??
    'application/octet-stream';
  const filename = request.query.get('filename');
  const sizeBytes = await storeUploadBody(request.body.stream, mediaId);
  await markUploaded(serverName(), mediaId, {
    content_type: contentType,
    filename: filename ?? undefined,
    size_bytes: sizeBytes,
  });
  return {};
}
