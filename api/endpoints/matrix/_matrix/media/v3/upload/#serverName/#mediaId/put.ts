import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/ids.ts';
import { assertLocalMxc, uploadMedia } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export const mediaUpload = true;

export default async function (request: PathfinderRequest, context: Context) {
  const caller = context.state.user as string;
  const mediaId = request.params.mediaId as string;
  assertLocalMxc(request.params.serverName as string, mediaId);
  const contentType = request.headers.get('Content-Type') ??
    'application/octet-stream';
  const filename = request.query.get('filename');
  await uploadMedia(theApp().tenant, localpartOf(caller), request.body.stream, {
    content_type: contentType,
    filename: filename ?? undefined,
  }, mediaId);
  return {};
}
