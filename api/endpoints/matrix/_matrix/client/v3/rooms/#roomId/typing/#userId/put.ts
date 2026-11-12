import { MatrixError } from '#engine/matrix-error.ts';
import { theApp } from '#engine/app.ts';
import { setTyping } from '#engine/typing.ts';
import { parseJson } from '@pathfinder/pathfinder/body';
import { decodeTypingRequest } from '#engine/client/ephemeral-request.ts';

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
  const body = decodeTypingRequest(await parseJson(request));
  const accepted = await setTyping(
    theApp().server,
    request.params.roomId as string,
    userId,
    body.typing,
    body.timeout,
  );
  if (!accepted) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'not joined to ' + request.params.roomId,
    );
  }
  return {};
}
