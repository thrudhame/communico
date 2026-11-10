import { MatrixError } from '#engine/matrix-error.ts';
import { setFullyRead, setReceipt } from '#engine/receipts.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const userId = context.state.user as string;
  const roomId = request.params.roomId as string;
  const body = (await parseJson(request)) as Record<string, unknown>;
  for (const key of ['m.fully_read', 'm.read', 'm.read.private']) {
    const v = body[key];
    if (v !== undefined && typeof v !== 'string') {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        key + ' must be an event id',
      );
    }
  }
  if (typeof body['m.fully_read'] === 'string') {
    await setFullyRead(roomId, userId, body['m.fully_read']);
  }
  if (typeof body['m.read'] === 'string') {
    await setReceipt(roomId, userId, 'm.read', body['m.read']);
  }
  if (typeof body['m.read.private'] === 'string') {
    await setReceipt(roomId, userId, 'm.read.private', body['m.read.private']);
  }
  return {};
}
