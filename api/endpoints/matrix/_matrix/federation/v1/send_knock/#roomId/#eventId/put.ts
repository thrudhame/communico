import { sendKnock } from '#engine/federation/joins.ts';
import { inviteDeps } from '#engine/federation/context.ts';
import { assertFederationEnabled } from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
export default async function (request: PathfinderRequest, context: Context) {
  assertFederationEnabled();
  const origin = context.state.origin as string | undefined;
  if (origin === undefined) {
    throw new MatrixError(
      401,
      'M_UNAUTHORIZED',
      'missing or invalid signature',
    );
  }
  return await sendKnock(
    request.params.roomId as string,
    request.params.eventId as string,
    await parseJson(request),
    origin,
    inviteDeps(),
  );
}
