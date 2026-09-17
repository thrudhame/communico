import { MatrixError } from '#engine/matrix-error.ts';
import { setPresence } from '#engine/presence.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/presence/#userId/status — own status only (403
// otherwise). Body {presence, status_msg?}; an omitted status_msg clears.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  if (request.params.userId !== userId) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'presence is per-user');
  }
  const body = (await parseJson(request)) as {
    presence?: unknown;
    status_msg?: unknown;
  };
  if (typeof body.presence !== 'string') {
    throw new MatrixError(400, 'M_MISSING_PARAM', 'presence is required');
  }
  await setPresence(
    userId,
    body.presence,
    typeof body.status_msg === 'string' ? body.status_msg : undefined,
  );
  return {};
}
