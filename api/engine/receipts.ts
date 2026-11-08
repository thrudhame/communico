// doltgres receipt entry point; client and federation share one durable writer.
import { theApp } from '#engine/app.ts';
import * as rows from '#engine/server/ephemeral.ts';
import { MatrixError } from '#engine/matrix-error.ts';
export const setReceipt = async (
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  eventId: string,
) => {
  if (
    !await rows.setReceipt(
      theApp().server,
      roomId,
      userId,
      receiptType,
      eventId,
    )
  ) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
};
