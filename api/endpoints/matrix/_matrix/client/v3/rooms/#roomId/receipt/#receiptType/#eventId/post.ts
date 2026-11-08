import { MatrixError } from '#engine/matrix-error.ts';
import { setReceipt } from '#engine/receipts.ts';

export default async function (
  request: import('@pathfinder/pathfinder').PathfinderRequest,
  context: import('@pathfinder/pathfinder').Context,
) {
  const receiptType = request.params.receiptType as string;
  if (receiptType !== 'm.read' && receiptType !== 'm.read.private') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unsupported receipt type: ' + receiptType,
    );
  }
  await setReceipt(
    request.params.roomId as string,
    context.state.user as string,
    receiptType,
    request.params.eventId as string,
  );
  return {};
}
