// Select a real server's declared auth set at the chosen historical parent.
// Sparse create-only auth sets are not valid membership/message fixtures.
import type { Pdu } from '#engine/pdu.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import type { Room } from '#engine/room/index.ts';
import { getRulebook } from '#engine/rulebook/index.ts';

export async function authAt(
  room: Room,
  pdu: Pick<Pdu, 'type' | 'sender' | 'content'> & { state_key?: string },
  after?: string,
): Promise<string[]> {
  return await room.tx(async (tx) => {
    const stay = (await tx.segments.openStay())!;
    const group = after === undefined
      ? await tx.state.current(stay.id)
      : (await tx.state.eventStateAfter(after))?.group;
    if (group === null || group === undefined) {
      throw new Error('fixture has no state');
    }
    return getRulebook(await roomVersionOf(tx, stay.id)).selectAuthEvents(
      pdu as Pdu,
      await tx.state.groupMap(group),
    );
  });
}
