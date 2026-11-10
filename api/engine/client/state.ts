import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  readPositionFor,
  requireRoom,
  stateAtSeq,
  type StateRow,
} from './room.ts';
import { renderStateEvent } from './render.ts';
export { writeStateKey } from './write.ts';

export async function clientEventsForRows(
  roomId: string,
  rows: StateRow[],
  userId?: string,
) {
  const room = await requireRoom(roomId);
  const out: Record<string, unknown>[] = [];
  for (const row of rows) {
    const ev = await renderStateEvent(
      room,
      row.eventId,
      userId === undefined
        ? undefined
        : { userId, deviceId: null, tenant: theApp().tenant },
    );
    if (ev !== null) out.push(ev);
  }
  return out;
}

export async function readStateKey(
  roomId: string,
  userId: string,
  type: string,
  stateKey: string,
  format: string | null,
): Promise<unknown> {
  await requireRoom(roomId);
  const at = await readPositionFor(userId, roomId);
  const row = (await stateAtSeq(roomId, at)).find((r) =>
    r.type === type && r.stateKey === stateKey
  );
  if (!row) {
    throw new MatrixError(
      404,
      'M_NOT_FOUND',
      'state key not found: ' + type + '/' + stateKey,
    );
  }
  const event = (await clientEventsForRows(roomId, [row], userId))[0];
  return format === 'event' ? event : event?.content;
}

export async function validateCanonicalAliasContent(
  roomId: string,
  content: Record<string, unknown>,
) {
  const { validateCanonicalAliasContent: validate } = await import(
    '#engine/server/aliases.ts'
  );
  await validate(theApp().server, roomId, content);
}
