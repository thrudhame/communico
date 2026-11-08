import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/ids.ts';
import { getMedia, markUploaded } from '#engine/tenant/media.ts';
import { assertLocalMxc, storeUploadBody } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const mediaId = request.params.mediaId as string;
  assertLocalMxc(request.params.serverName as string, mediaId);
  const row = await getMedia(theApp().tenant, mediaId);
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
  await markUploaded(theApp().tenant, mediaId, {
    content_type: contentType,
    filename: filename ?? undefined,
    size_bytes: sizeBytes,
  });
  return {};
}
