import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { localpartOf } from '#engine/ids.ts';
import { reserveMedia } from '#engine/media.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (_request: PathfinderRequest, context: Context) {
  const { mediaId, expires } = await reserveMedia(
    theApp().tenant,
    localpartOf(context.state.user as string),
  );
  return {
    content_uri: `mxc://${serverName()}/${mediaId}`,
    unused_expires_at: expires,
  };
}
