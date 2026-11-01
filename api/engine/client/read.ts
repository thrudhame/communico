// Client publication cuts are not event-DAG after-state. Translate the
// server feed cut to (stay, room change pos), then use R6 publications.
import { theApp } from '#engine/app.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';

export type StateRow = {
  type: string;
  stateKey: string;
  eventId: string;
  content: Record<string, unknown>;
  sender: string;
  originTs: number;
};

export async function stateAtSeq(
  room: Room,
  seq: number,
  stay?: number,
): Promise<StateRow[]> {
  const rows = await theApp().server.query(
    'SELECT pos, stay FROM feed WHERE room = ? AND seq <= ? ORDER BY seq DESC LIMIT 1',
    [room.id, seq],
  );
  return await room.tx(async (tx) => {
    const selected = stay ?? (rows.length ? Number(rows[0].stay) : null);
    if (selected === null) return [];
    const pos = rows.length && Number(rows[0].stay) === selected
      ? Number(rows[0].pos)
      : 0;
    const group = await tx.state.publishedAt(selected, pos);
    if (group === null) return [];
    const map = await tx.state.groupMap(group);
    const out: StateRow[] = [];
    for (const [key, eventId] of map) {
      const row = await tx.events.get(eventId);
      if (row === null) continue;
      const pdu = JSON.parse(row.pdu) as Pdu;
      const sep = key.indexOf('\0');
      out.push({
        type: key.slice(0, sep),
        stateKey: key.slice(sep + 1),
        eventId,
        content: pdu.content,
        sender: pdu.sender,
        originTs: pdu.origin_server_ts,
      });
    }
    return out;
  });
}

export async function heldRoom(roomId: string): Promise<Room | null> {
  try {
    return await openRoom(theApp().store, roomId);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
