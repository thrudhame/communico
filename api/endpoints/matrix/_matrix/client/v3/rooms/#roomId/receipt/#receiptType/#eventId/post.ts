import { MatrixError } from '#engine/matrix-error.ts';
import { setReceipt } from '#engine/receipts.ts';
import { parseJson } from '#engine/operation-body.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const receiptType = request.params.receiptType as string;
  if (
    receiptType !== 'm.read' && receiptType !== 'm.read.private' &&
    receiptType !== 'm.fully_read'
  ) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unsupported receipt type: ' + receiptType,
    );
  }
  const body = await parseJson(request);
  await setReceipt(
    request.params.roomId as string,
    context.state.user as string,
    receiptType,
    request.params.eventId as string,
    { threadId: (body as Record<string, unknown>).thread_id },
  );
  return {};
}
