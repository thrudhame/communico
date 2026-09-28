// POST /_matrix/federation/v1/get_missing_events/{roomId} — the events
// between the requester's earliest and latest (backfill.yaml:71-141).
// Auth: the folder's 20-auth.ts.
import { serveGetMissingEvents } from '#engine/federation/serve.ts';
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
  const body = await request.body.json().catch(() => {
    throw new MatrixError(400, 'M_BAD_JSON', 'body must be JSON');
  });
  return await serveGetMissingEvents(
    request.params.roomId as string,
    body as Record<string, unknown>,
    origin,
  );
}
