import { contentDisposition, serveMedia } from '#engine/media.ts';
import { safeFilename } from '#engine/media/service.ts';
import type { PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest) {
  const response = await serveMedia(
    request.params.serverName as string,
    request.params.mediaId as string,
  );
  response.headers.set(
    'Content-Disposition',
    contentDisposition(
      response.headers.get('content-type') ?? 'application/octet-stream',
      safeFilename(request.params.filename as string),
    ),
  );
  return response;
}
