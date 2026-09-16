import { serverName } from '#engine/config.ts';
import { localpartOf } from '#engine/auth.ts';
import { createMedia } from '#engine/tenant.ts';
import { newMediaId, storeUploadBody } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// POST /_matrix/media/v3/upload — "Upload some content to the content
// repository." (spec v1.16,
// https://spec.matrix.org/v1.16/client-server-api/#post_matrixmediav3upload)
// The request body is the raw bytes; the Content-Type header is stored
// verbatim (default application/octet-stream when absent — Complement M1
// asserts the exact echo, incl. non-standard types), and ?filename= is
// stored for the download Content-Disposition. Bytes stream to disk under
// MEDIA_ROOT — this subtree sits outside the client/ JSON middleware
// (plan §3.5). Auth: folder middleware (20-auth.ts).
export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const contentType = request.headers.get('Content-Type') ??
    'application/octet-stream';
  const filename = request.query.get('filename');
  const mediaId = newMediaId();
  const sizeBytes = await storeUploadBody(request.body.stream, mediaId);
  await createMedia(serverName(), localpartOf(caller), mediaId, 'uploaded', {
    content_type: contentType,
    filename: filename ?? undefined,
    size_bytes: sizeBytes,
  });
  return { content_uri: `mxc://${serverName()}/${mediaId}` };
}
