import { serveMedia } from '#engine/media.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// Legacy unauthenticated download, as on doltgres.
export default async function (request: PathfinderRequest) {
  return await serveMedia(
    request.params.serverName as string,
    request.params.mediaId as string,
  );
}
