// Federation's room reads: snapshots and bounded auth walks share one contract.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, type RoomTx } from '#engine/room/index.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import type { Store } from '#engine/store/index.ts';

export async function heldRoom(store: Store, roomId: string) {
  try {
    return await openRoom(store, roomId);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new MatrixError(404, 'M_NOT_FOUND', roomId);
    }
    throw error;
  }
}

export async function currentSnapshot(tx: RoomTx) {
  const open = await tx.segments.openStay();
  const stay = open === null ? await tx.segments.latestStay() : open;
  if (stay === null) throw new MatrixError(404, 'M_NOT_FOUND', 'no stay');
  const group = await tx.state.current(stay.id);
  if (group === null) throw new MatrixError(404, 'M_NOT_FOUND', 'no state');
  return {
    stay,
    version: await roomVersionOf(tx, stay.id),
    state: await tx.state.groupMap(group),
  };
}

export async function pduAt(tx: RoomTx, id: string): Promise<Pdu | null> {
  const row = await tx.events.get(id);
  return row === null ? null : JSON.parse(row.pdu) as Pdu;
}

export async function authClosure(tx: RoomTx, seeds: string[]) {
  const walk = await tx.events.authClosure(seeds, 100_000);
  if (walk.truncated) {
    throw new MatrixError(
      503,
      'M_UNKNOWN',
      'auth closure exceeds 100000 events',
    );
  }
  const rows = await tx.events.list([...new Set([...seeds, ...walk.ids])]);
  return {
    ids: walk.ids,
    pdus: new Map(
      [...rows].map(([id, row]) => [id, JSON.parse(row.pdu) as Pdu]),
    ),
  };
}

export async function serverInState(
  tx: RoomTx,
  state: Map<string, string>,
  origin: string,
  invited = false,
): Promise<boolean> {
  for (const [key, id] of state) {
    if (!key.startsWith('m.room.member\0')) continue;
    if (!key.slice('m.room.member\0'.length).endsWith(':' + origin)) continue;
    const pdu = await pduAt(tx, id);
    const membership = pdu?.content?.membership;
    if (membership === 'join' || (invited && membership === 'invite')) {
      return true;
    }
  }
  return false;
}
