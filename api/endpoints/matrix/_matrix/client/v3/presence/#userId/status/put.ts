import { MatrixError } from '#engine/matrix-error.ts';
import { setPresence } from '#engine/presence.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import { decodePresenceRequest } from '#engine/client/ephemeral-request.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  if (request.params.userId !== userId) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'presence is per-user');
  }
  const body = decodePresenceRequest(await parseJson(request));
  await setPresence(
    userId,
    body.presence,
    body.status,
  );
  return {};
}
