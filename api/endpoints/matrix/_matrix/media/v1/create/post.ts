import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/auth.ts';
import { createMedia, getMedia } from '#engine/tenant.ts';
import { newMediaId } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

// POST /_matrix/media/v1/create — "Create a new mxc:// URI without
// uploading the content." (spec v1.16, added v1.7,
// https://spec.matrix.org/v1.16/client-server-api/#post_matrixmediav1create)
// "The recommended default expiration is 24 hours" → unused_expires_at =
// created_ms + 86400000. The spec's rate/quota SHOULDs (429
// M_LIMIT_EXCEEDED for pending-upload floods) are not enforced in M2
// (plan §7 — no rate limiting). Auth: folder middleware on media/v1/.
export default async function (_request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const mediaId = newMediaId();
  await createMedia(serverName(), localpartOf(caller), mediaId, 'pending');
  const row = await getMedia(serverName(), mediaId);
  if (row === null) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Media row vanished after create');
  }
  return {
    content_uri: `mxc://${serverName()}/${mediaId}`,
    unused_expires_at: row.created_ms + 86_400_000,
  };
}
