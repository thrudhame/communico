import { MatrixError } from '#engine/matrix-error.ts';
import { setTyping } from '#engine/typing.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

// PUT /_matrix/client/v3/rooms/#roomId/typing/#userId — start or stop the
// caller's typing marker (spec v1.16 typing.yaml; band C D2). Own user
// only → 403 M_FORBIDDEN. {typing:false} may omit timeout.
export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const caller = context.state.user as string;
  const userId = request.params.userId as string;
  if (userId !== caller) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'cannot set typing for another user',
    );
  }
  const body = (await parseJson(request)) as Record<string, unknown>;
  const timeout = typeof body.timeout === 'number' ? body.timeout : undefined;
  setTyping(
    request.params.roomId as string,
    userId,
    body.typing === true,
    timeout,
  );
  return {};
}
