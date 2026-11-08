import { theApp } from '#engine/app.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { relationsOf, threadRootsOf } from '#engine/server/read.ts';
import { requireRoom } from './room.ts';
import { parseStreamToken } from './timeline.ts';
import { renderEvent } from './render.ts';
import { canSeeEvent } from './visibility.ts';
export async function relationsPage(
  roomId: string,
  eventId: string,
  filters: { relType?: string; eventType?: string },
  query: { dir: string | null; limit: string | null; from: string | null },
  viewer: string,
) {
  const dir = query.dir ?? 'b';
  if (dir !== 'b' && dir !== 'f') {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'bad dir: ' + dir);
  }
  const limit = query.limit === null
      ? 10
      : Math.max(0, Number(query.limit) || 0),
    from = parseStreamToken(query.from)?.eSeq ?? null;
  const room = await requireRoom(roomId);
  if (!await canSeeEvent(viewer, room, eventId)) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  const rendered: { seq: number; ev: Record<string, unknown> }[] = [];
  for (
    const row of await relationsOf(
      theApp().server,
      roomId,
      eventId,
      filters.relType,
    )
  ) {
    const ev = await renderEvent(room, row.eventId, {
      userId: viewer,
      deviceId: null,
    });
    if (
      ev !== null &&
      (filters.eventType === undefined || ev.type === filters.eventType)
    ) rendered.push({ seq: row.seq, ev });
  }
  rendered.sort((a, b) => dir === 'b' ? b.seq - a.seq : a.seq - b.seq);
  const window = rendered.filter((r) =>
      from === null || (dir === 'b' ? r.seq < from : r.seq > from)
    ),
    slice = window.slice(0, limit === 0 ? window.length : limit);
  const out: { chunk: Record<string, unknown>[]; next_batch?: string } = {
    chunk: slice.map((r) => r.ev),
  };
  if (limit > 0 && window.length > limit && slice.length > 0) {
    out.next_batch = 's' + slice[slice.length - 1].seq;
  }
  return out;
}
export async function threads(
  roomId: string,
  viewer: string,
  include: 'all' | 'participated',
  page: { fromSeq: number | null; limit: number },
) {
  const room = await requireRoom(roomId);
  const roots = await threadRootsOf(theApp().server, roomId);
  const rendered: { latestSeq: number; ev: Record<string, unknown> }[] = [];
  for (const root of roots) {
    const ev = await renderEvent(room, root.eventId, {
      userId: viewer,
      deviceId: null,
    });
    if (ev === null) continue;
    const unsigned = ev.unsigned as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    if (
      include === 'participated' &&
      unsigned['m.relations']?.['m.thread']?.current_user_participated !== true
    ) continue;
    const latest = unsigned['m.relations']?.['m.thread']?.latest_event as
      | Record<string, unknown>
      | undefined;
    if (latest === undefined) continue;
    const children = await relationsOf(
      theApp().server,
      roomId,
      root.eventId,
      'm.thread',
    );
    const child = children.find((r) => r.eventId === latest.event_id);
    if (child !== undefined) rendered.push({ latestSeq: child.seq, ev });
  }
  rendered.sort((a, b) =>
    b.latestSeq - a.latestSeq ||
    String(a.ev.event_id).localeCompare(String(b.ev.event_id))
  );
  const window = rendered.filter((r) =>
    page.fromSeq === null || r.latestSeq < page.fromSeq
  );
  const slice = window.slice(
    0,
    page.limit === 0 ? window.length : Math.max(0, page.limit),
  );
  const out: { chunk: Record<string, unknown>[]; next_batch?: string } = {
    chunk: slice.map((r) => r.ev),
  };
  if (page.limit > 0 && window.length > page.limit && slice.length > 0) {
    out.next_batch = 's' + slice[slice.length - 1].latestSeq;
  }
  return out;
}
