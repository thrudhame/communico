import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { localpartOf } from '#engine/ids.ts';
import { createMedia, getMedia } from '#engine/tenant/media.ts';
import { newMediaId } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (_request: PathfinderRequest, context: Context) {
  const mediaId = newMediaId();
  await createMedia(
    theApp().tenant,
    localpartOf(context.state.user as string),
    mediaId,
    'pending',
  );
  const row = await getMedia(theApp().tenant, mediaId);
  if (row === null) {
    throw new MatrixError(500, 'M_UNKNOWN', 'Media row vanished after create');
  }
  return {
    content_uri: `mxc://${serverName()}/${mediaId}`,
    unused_expires_at: row.created_ms + 86_400_000,
  };
}
