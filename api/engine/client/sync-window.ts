// Both sync protocols select visible live rows before applying the limit.
// Pagination/token policy stays with the caller; these are actual returned cuts.
import { theApp } from '#engine/app.ts';
import { renderEvents, type Viewer } from './render.ts';
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
      const ids = page.map((r) => r.event);
      const stored = await tx.events.list(ids);
      const refs = await tx.state.eventStateRefs(ids);
      const boundaries = new Set(
        ids.filter((id) => refs.get(id)?.before?.provenance === 'imported'),
      );
      return { stored, boundaries };
    });
    const candidates: FeedRow[] = [];
    const pageStay = newestStay ?? page[0].stay;
    for (const row of page) {
      if (row.stay !== pageStay) break;
      const record = stored.get(row.event);
      if (
        record !== undefined && eventMatchesRoomEventFilter(
          null,
          { ...JSON.parse(record.pdu) as Pdu, room_id: room.id },
          input.filter ?? {},
        )
      ) candidates.push(row);
      if (boundaries.has(row.event)) break;
    }
    const rendered = await renderEvents(
      room,
      candidates.map((row) => row.event),
      viewer,
      {
        omitRoomId: true,
        eventFormat: input.eventFormat,
        take: input.limit + 1 - eligible.length,
        publications: new Map(
          candidates.map((
            row,
          ) => [row.event, { pos: row.pos, stay: row.stay }]),
        ),
      },
    );
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
      const event = rendered.get(row.event);
      if (event !== undefined) {
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
