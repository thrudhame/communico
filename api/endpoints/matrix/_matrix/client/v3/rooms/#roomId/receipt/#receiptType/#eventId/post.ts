import { MatrixError } from '#engine/matrix-error.ts';
import { setReceipt } from '#engine/receipts.ts';
import { parseJson } from '@pathfinder/pathfinder/body';

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
  // Pathfinder always exposes a memoized body view, even for an empty POST.
  const bytes = await request.body.bytes();
  const body = new TextDecoder().decode(bytes).trim() === ''
    ? {}
    : await parseJson(request);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'receipt body must be an object');
  }
  await setReceipt(
    request.params.roomId as string,
    context.state.user as string,
    receiptType,
    request.params.eventId as string,
    { threadId: (body as Record<string, unknown>).thread_id },
  );
  return {};
}
