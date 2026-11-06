import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { localpartOf } from '#engine/ids.ts';
import { createMedia } from '#engine/tenant/media.ts';
import { newMediaId, storeUploadBody } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const contentType = request.headers.get('Content-Type') ??
    'application/octet-stream';
  const filename = request.query.get('filename');
  const mediaId = newMediaId();
  const sizeBytes = await storeUploadBody(request.body.stream, mediaId);
  await createMedia(theApp().tenant, localpartOf(caller), mediaId, 'uploaded', {
    content_type: contentType,
    filename: filename ?? undefined,
    size_bytes: sizeBytes,
  });
  return { content_uri: `mxc://${serverName()}/${mediaId}` };
}
