import { MatrixError } from '#engine/matrix-error.ts';
import { setClientTyping } from '#engine/client/typing.ts';
import { parseJson } from '#engine/operation-body.ts';
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
  await setClientTyping(
    request.params.roomId as string,
    userId,
    body.typing,
    body.timeout,
    typeof context.state.device === 'string'
      ? {
        deviceId: context.state.device,
        generation: Number(context.state.deviceGeneration ?? 0),
      }
      : undefined,
  );
  return {};
}
