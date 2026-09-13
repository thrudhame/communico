import { serveMedia } from '#engine/media.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/client/v1/media/download/{serverName}/{mediaId} — the
// authenticated download (spec v1.16, added v1.11,
// https://spec.matrix.org/v1.16/client-server-api/#get_matrixclientv1mediadownloadservernamemediaid).
// Auth is folder middleware (client/v1/media/20-auth.ts): a missing or
// unknown token gets 401 BEFORE any lookup (Complement M1). The GET has
// no body — the client/ JSON middleware skips it (plan §3.5).
export default async function (request: PathfinderRequest) {
  return await serveMedia(
    request.params.serverName as string,
    request.params.mediaId as string,
  );
}
