// doltgres receipt entry point; client and federation share one durable writer.
import { theApp } from '#engine/app.ts';
import * as rows from '#engine/server/ephemeral.ts';
export const setReceipt = (
  roomId: string,
  userId: string,
  receiptType: 'm.read' | 'm.read.private',
  eventId: string,
) => rows.setReceipt(theApp().server, roomId, userId, receiptType, eventId);
