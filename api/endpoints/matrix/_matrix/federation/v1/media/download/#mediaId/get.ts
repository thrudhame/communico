import { serveMedia } from '#engine/media.ts';
import { serverName } from '#engine/config.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { multipartResponse } from '#engine/media/multipart.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest) {
  assertFederationEnabled();
  return multipartResponse(
    await serveMedia(serverName(), request.params.mediaId as string),
  );
}
