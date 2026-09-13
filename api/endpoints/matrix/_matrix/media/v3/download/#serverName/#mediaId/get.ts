import { serveMedia } from '#engine/media.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';

// GET /_matrix/media/v3/download/{serverName}/{mediaId} — the legacy
// UNAUTHENTICATED download, deprecated in v1.11 in favour of
// /_matrix/client/v1/media/download (spec v1.16,
// https://spec.matrix.org/v1.16/client-server-api/#get_matrixmediav3downloadservernamemediaid).
// No auth here by design (Complement M2 exercises it); the deprecated
// endpoint is frozen at a later milestone (plan §7). 404/504 semantics
// and headers: serveMedia.
export default async function (request: PathfinderRequest) {
  return await serveMedia(
    request.params.serverName as string,
    request.params.mediaId as string,
  );
}
