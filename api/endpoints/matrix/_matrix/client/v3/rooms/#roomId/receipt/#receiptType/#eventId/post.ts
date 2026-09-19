import { MatrixError } from '#engine/matrix-error.ts';
import { setReceipt } from '#engine/receipts.ts';

// POST /_matrix/client/v3/rooms/#roomId/receipt/#receiptType/#eventId —
// the "up to" marker (spec v1.16 receipts.yaml; band C §2). m.read and
// m.read.private are accepted and stored (private is never broadcast);
// m.fully_read is routed to /read_markers by clients (receipts.yaml:41-46
// — out of the plan's "m.read only for now" scope) and other types are
// refused.
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
