import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import { config } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';

declare module '@pathfinder/pathfinder' {
  interface Meta {
    mediaUpload?: boolean;
  }
}

export const disableStreaming = true;

// One admission boundary for every non-upload request, including endpoints
// that ignore their body and route misses. Count bytes before JSON parsing or
// authentication, without trusting Content-Length. Uploads retain their own
// streaming media limit, selected by endpoint metadata, not URL heuristics.
export default async function (request: PathfinderRequest, context: Context) {
  const upload = context.meta.mediaUpload === true;
  let remaining = upload
    ? config().media.maxbytes
    : config().server.maxrequestbytes;
  const tooLarge = () =>
    new MatrixError(413, 'M_TOO_LARGE', 'Payload too large');
  const length = request.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > remaining) {
    throw tooLarge();
  }
  // Reject an explicitly oversized upload before it tries to stage a file.
  // Actual upload bytes are still counted by the streaming media owner.
  if (upload) return;
  request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (chunk.byteLength > remaining) throw tooLarge();
        remaining -= chunk.byteLength;
        controller.enqueue(chunk);
      },
    }),
  );
  // Memoized by Pathfinder and reused by JSON validation, federation auth and
  // handlers. This also bounds bodies on handlers that never consume them.
  await request.body.bytes();
}
