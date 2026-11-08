// doltgres receipt entry point; client and federation share one durable writer.
import { theApp } from '#engine/app.ts';
import * as rows from '#engine/server/ephemeral.ts';
import { isJoined, threadOfEvent } from '#engine/server/read.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export async function setReceipt(
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  eventId: string,
  opts: { threadId?: unknown } = {},
): Promise<void> {
  const server = theApp().server;
  let threadId: string | null = null;
  if (opts.threadId !== undefined) {
    if (!await isJoined(server, roomId, userId)) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
    }
    if (typeof opts.threadId !== 'string' || opts.threadId.length === 0) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'thread_id must be a non-empty string',
      );
    }
    threadId = opts.threadId;
    if (threadId !== await threadOfEvent(server, roomId, eventId)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'event_id is not in the given thread',
      );
    }
  }
  if (
    !await rows.setReceipt(server, roomId, userId, receiptType, eventId, {
      threadId,
    })
  ) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
}
