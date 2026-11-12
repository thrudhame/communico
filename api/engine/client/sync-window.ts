// Both sync protocols select visible live rows before applying the limit.
// Pagination/token policy stays with the caller; these are actual returned cuts.
import { theApp } from '#engine/app.ts';
import { stateAtSeq } from './read.ts';
import { renderEvent, type Viewer } from './render.ts';
import type { Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import { feedBefore, type FeedRow } from '#engine/server/read.ts';
import {
  type EventFilter,
  eventMatchesRoomEventFilter,
} from '#engine/tenant/filters.ts';

export async function syncWindow(
  room: Room,
  viewer: Viewer,
  input: {
    since: number;
    end: number;
    limit: number;
    filter?: EventFilter;
    eventFormat?: 'client' | 'federation';
  },
) {
  const eligible: { row: FeedRow; event: Record<string, unknown> }[] = [];
  let cursor = input.end;
  let more = true;
  let gap = false;
  let newestStay: number | undefined;
  while (more && !gap && eligible.length <= input.limit) {
    const page = await feedBefore(
      theApp().server,
      room.id,
      input.since,
      cursor,
      32,
    );
    more = page.length === 32;
    if (!page.length) break;
    cursor = page.at(-1)!.seq - 1;
    const { stored, boundaries } = await room.tx(async (tx) => {
      const stored = await tx.events.list(page.map((r) => r.event));
      const boundaries = new Set<string>();
      for (const row of page) {
        if (
          (await tx.state.eventStateBefore(row.event))?.provenance ===
            'imported'
        ) boundaries.add(row.event);
      }
      return { stored, boundaries };
    });
    for (const row of page) {
      newestStay ??= row.stay;
      if (row.stay !== newestStay) {
        gap = true;
        break;
      }
      // An imported before-state is a real history gap even if its event is
      // hidden. Never splice older feed rows across the boundary.
      gap = boundaries.has(row.event);
      const record = stored.get(row.event);
      if (record === undefined) {
        if (gap) break;
        continue;
      }
      const pdu = JSON.parse(record.pdu) as Pdu;
      if (
        !eventMatchesRoomEventFilter(
          null,
          { ...pdu, room_id: room.id },
          input.filter ?? {},
        )
      ) {
        if (gap) break;
        continue;
      }
      const at = await stateAtSeq(room, row.seq, row.stay, [[
        'm.room.member',
        viewer.userId,
      ]]);
      const membership = at.find((s) =>
        s.type === 'm.room.member' && s.stateKey === viewer.userId
      )?.content.membership ?? 'leave';
      const event = await renderEvent(room, row.event, {
        ...viewer,
        membership: String(membership),
      }, { omitRoomId: true, eventFormat: input.eventFormat });
      if (event !== null) {
        eligible.unshift({ row, event });
      }
      if (gap || eligible.length > input.limit) {
        break;
      }
    }
  }
  const trimmed = eligible.length > input.limit;
  const selected = input.limit === 0
    ? []
    : trimmed
    ? eligible.slice(eligible.length - input.limit)
    : eligible;
  return {
    rows: selected.map((item) => item.row),
    events: selected.map((item) => item.event),
    gap,
    trimmed,
  };
}
