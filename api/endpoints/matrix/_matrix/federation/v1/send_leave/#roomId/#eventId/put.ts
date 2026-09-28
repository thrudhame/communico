// PUT /_matrix/federation/v1/send_leave/{roomId}/{eventId} — the v1
// leave handshake (leaving-v1.yaml:141-217: [200, {}]). Auth: the
// folder's 20-auth.ts.
import { sendLeave } from '#engine/federation/joins.ts';
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
  return await sendLeave(
    request.params.roomId as string,
    request.params.eventId as string,
    body,
    origin,
    'v1',
  );
}
