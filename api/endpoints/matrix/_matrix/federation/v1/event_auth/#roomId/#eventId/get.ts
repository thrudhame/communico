// GET /_matrix/federation/v1/event_auth/{roomId}/{eventId} — the
// complete auth chain of an event (event_auth.yaml:19-63). Auth: the
// folder's 20-auth.ts.
import { serveEventAuth } from '#engine/federation/serve.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';

export default async function (
  request: PathfinderRequest,
  context: Context,
) {
  assertFederationEnabled();
  const origin = context.state.origin as string | undefined;
  if (origin === undefined) {
    throw new MatrixError(
      401,
      'M_UNAUTHORIZED',
      'missing or invalid signature',
    );
  }
  return await serveEventAuth(
    request.params.roomId as string,
    request.params.eventId as string,
    origin,
  );
}
