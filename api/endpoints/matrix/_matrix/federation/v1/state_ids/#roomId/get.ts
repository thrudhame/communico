// GET /_matrix/federation/v1/state_ids/{roomId}?event_id= — the state
// event ids at an event (events.yaml:88-169). Auth: the folder's
// 20-auth.ts.
import { serveStateIds } from '#engine/federation/serve.ts';
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
  const eventId = request.query.get('event_id');
  if (eventId === null) {
    throw new MatrixError(400, 'M_BAD_JSON', 'event_id is required');
  }
  return await serveStateIds(request.params.roomId as string, eventId, origin);
}
