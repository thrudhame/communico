// PUT /_matrix/federation/v2/invite/{roomId}/{eventId} — an invite for
// one of our users into a room we may not hold (invites-v2.yaml:21-192;
// §3.8). Auth: the folder's 20-auth.ts.
import { receiveInvite } from '#engine/federation/invites.ts';
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
  return await receiveInvite(
    request.params.roomId as string,
    request.params.eventId as string,
    body,
    origin,
  );
}
