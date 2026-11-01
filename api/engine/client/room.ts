// Client room lookup and state reads. Room truth stays behind RoomTx;
// server membership is the read-position authority (including forgotten).
import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { membershipOf } from '#engine/server/read.ts';

export async function lookupRoom(roomId: string): Promise<Room | null> {
  try {
    return await openRoom(theApp().store, roomId);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

export async function requireRoom(roomId: string): Promise<Room> {
  const room = await lookupRoom(roomId);
  if (room === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  return room;
}

export async function versionOf(room: Room): Promise<string> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.latestStay();
    if (stay === null) throw new Error('E_NO_STAY: ' + room.id);
    return await roomVersionOf(tx, stay.id);
  });
}

export async function readPositionFor(userId: string, roomId: string) {
  const m = await membershipOf(theApp().server, roomId, userId);
  if (m === null) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not a member of ' + roomId);
  }
  if (m.forgotten) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'room forgotten: ' + roomId);
  }
  return m.membership === 'join' ? null : m.seq;
}

export type StateRow = {
  type: string;
  stateKey: string;
  eventId: string;
  content: Record<string, unknown>;
};

export async function stateAtSeq(
  roomId: string,
  seq: number | null,
): Promise<StateRow[]> {
  const room = await requireRoom(roomId);
  const feed = seq === null ? [] : await theApp().server.query(
    'SELECT stay, pos FROM feed WHERE room = ? AND seq <= ? ORDER BY seq DESC LIMIT 1',
    [roomId, seq],
  );
  return await room.tx(async (tx) => {
    const stay = seq === null ? await tx.segments.latestStay() : null;
    const group = seq === null
      ? stay === null ? null : await tx.state.current(stay.id)
      : feed.length === 0
      ? null
      : await tx.state.publishedAt(Number(feed[0].stay), Number(feed[0].pos));
    if (group === null) return [];
    const rows: StateRow[] = [];
    for (const entry of await tx.state.groupEntries(group)) {
      if (entry.event === null) continue;
      const row = await tx.events.get(entry.event);
      if (row === null) continue;
      rows.push({
        type: entry.type,
        stateKey: entry.state_key,
        eventId: entry.event,
        content: (JSON.parse(row.pdu) as Pdu).content ?? {},
      });
    }
    return rows;
  });
}
