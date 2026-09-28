// GET /_matrix/federation/v1/event/{eventId} — a single event
// (events.yaml:170-191; single_pdu_transaction.yaml:14-32). Auth: the
// folder's 20-auth.ts.
import { serveEvent } from '#engine/federation/serve.ts';
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
  return await serveEvent(request.params.eventId as string, origin);
}
