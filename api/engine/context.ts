// api/engine/context.ts — GET /rooms/{roomId}/context/{eventId}
// (event_context.yaml at v1.16). Limit splits floor(n/2) before /
// n−before after (Synapse get_event_context). Filter applies to
// events_before, events_after, and state — not to event
// (event_context.yaml:59-67). State is the room state at the last
// event returned (yaml:104-106). Invisible anchor → 404 M_NOT_FOUND.
import { MatrixError } from './matrix-error.ts';
import {
  eventMatchesRoomEventFilter,
  type RoomEventFilter,
} from './filters.ts';
import { eventIndexRow, lookupRoom, membershipOf, stateAtSeq } from './room.ts';
import { clientEventsForRows } from './stateops.ts';
import { clientEventForRow, messages, pduById } from './timeline.ts';
import { canSeeEvent } from './visibility.ts';

export interface EventContextOpts {
  limit: number;
  filter: RoomEventFilter;
  lazyLoadMembers: boolean;
}

function matchesFilter(
  e: Record<string, unknown>,
  filter: RoomEventFilter,
): boolean {
  const content = e.content;
  return eventMatchesRoomEventFilter(
    null,
    {
      type: String(e.type),
      sender: String(e.sender),
      content: content !== null && typeof content === 'object' &&
          !Array.isArray(content)
        ? content as Record<string, unknown>
        : {},
    },
    filter,
  );
}

export async function eventContext(
  userId: string,
  deviceId: string | null,
  roomId: string,
  eventId: string,
  opts: EventContextOpts,
): Promise<Record<string, unknown>> {
  const room = await lookupRoom(roomId);
  if (!room) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  const idx = await eventIndexRow(roomId, eventId);
  const pdu = idx ? await pduById(room.dbName, idx.commit_hash, eventId) : null;
  if (!idx || !pdu || idx.rejected || idx.soft_failed) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }
  if (
    !(await canSeeEvent(userId, roomId, {
      seq: idx.seq,
      type: pdu.type,
      stateKey: pdu.state_key,
    }))
  ) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }

  const membership = await membershipOf(roomId, userId);
  if (membership !== null && membership.forgotten) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'room forgotten: ' + roomId);
  }
  let leaveAt: number | null = null;
  if (membership !== null && membership.membership !== 'join') {
    leaveAt = membership.seq;
  }

  const beforeLimit = Math.floor(opts.limit / 2);
  const afterLimit = opts.limit - beforeLimit;
  const before = await messages({
    roomId,
    userId,
    deviceId,
    leaveAt,
    dir: 'b',
    fromSeq: idx.seq - 1,
    toSeq: null,
    limit: beforeLimit,
    lazyLoadMembers: false,
  });
  const after = await messages({
    roomId,
    userId,
    deviceId,
    leaveAt,
    dir: 'f',
    fromSeq: idx.seq,
    toSeq: null,
    limit: afterLimit,
    lazyLoadMembers: false,
  });

  const eventsBefore = before.chunk.filter((e) =>
    matchesFilter(e, opts.filter)
  );
  const eventsAfter = after.chunk.filter((e) => matchesFilter(e, opts.filter));

  const event = await clientEventForRow(room.dbName, room.roomVersion, idx, {
    userId,
    deviceId,
  });
  if (!event) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'event not found: ' + eventId);
  }

  let lastSeq = idx.seq;
  if (eventsAfter.length > 0) {
    const lastId = eventsAfter[eventsAfter.length - 1].event_id;
    if (typeof lastId === 'string') {
      const lastIdx = await eventIndexRow(roomId, lastId);
      if (lastIdx !== null) lastSeq = lastIdx.seq;
    }
  }

  const stateAt = await stateAtSeq(roomId, lastSeq);
  const stateRows = stateAt !== null ? stateAt : [];
  let state = await clientEventsForRows(
    room.dbName,
    roomId,
    stateRows,
    room.roomVersion,
  );
  state = state.filter((e) => matchesFilter(e, opts.filter));
  if (opts.lazyLoadMembers) {
    const senders = new Set<string>([String(event.sender)]);
    for (const e of eventsBefore) senders.add(String(e.sender));
    for (const e of eventsAfter) senders.add(String(e.sender));
    state = state.filter((e) =>
      e.type !== 'm.room.member' || senders.has(String(e.state_key))
    );
  }

  const result: Record<string, unknown> = {
    events_before: eventsBefore,
    event,
    events_after: eventsAfter,
    state,
  };
  if (before.end !== undefined) result.start = before.end;
  if (after.end !== undefined) result.end = after.end;
  return result;
}
