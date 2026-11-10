// doltgres receipt entry point; client and federation share one durable writer.
import { theApp } from '#engine/app.ts';
import * as rows from '#engine/server/ephemeral.ts';
import { isJoined } from '#engine/server/read.ts';
import { openRoom } from '#engine/room/index.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { putAccountData } from '#engine/tenant/accountdata.ts';
import { localpartOf } from '#engine/ids.ts';
import { canSeeEvent } from '#engine/client/visibility.ts';

export async function setFullyRead(
  roomId: string,
  userId: string,
  eventId: string,
): Promise<void> {
  const app = theApp();
  let known = false;
  try {
    const room = await openRoom(app.store, roomId);
    known = await canSeeEvent(userId, room, eventId);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (!known) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found in room');
  }
  await putAccountData(
    app.tenant,
    localpartOf(userId),
    roomId,
    'm.fully_read',
    { event_id: eventId },
  );
}

export async function setReceipt(
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private' | 'm.fully_read',
  eventId: string,
  opts: { threadId?: unknown } = {},
): Promise<void> {
  const server = theApp().server;
  if (receiptType === 'm.fully_read') {
    if (opts.threadId !== undefined) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'thread_id must not be set for m.fully_read',
      );
    }
    await setFullyRead(roomId, userId, eventId);
    return;
  }
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
  }
  if (
    !await rows.setReceipt(server, roomId, userId, receiptType, eventId, {
      threadId,
      requireRelated: true,
    })
  ) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined to ' + roomId);
  }
}
