// Protocol room payloads compose existing publication, display and live-window owners.
import { heldRoom, stateAtSeq, type StateRow } from '#engine/client/read.ts';
import {
  admitState,
  type StateAdmission,
} from '#engine/client/state-admission.ts';
import {
  renderPrejoinDeparture,
  renderStateEvent,
  type Viewer,
} from '#engine/client/render.ts';
import { syncWindow } from '#engine/client/sync-window.ts';
import { StateDelivery } from '#engine/client/state-delivery.ts';
import { formatStreamToken } from '#engine/client/tokens.ts';
import type { Room } from '#engine/room/index.ts';
import {
  prejoinDisplay,
  savedPrejoinDisplay,
  stripPrejoin,
} from '#engine/federation/prejoin.ts';
import { formatCursor } from '#engine/room/segments.ts';
import type { ListSelection } from './lists.ts';
import type { RoomConfig } from './types.ts';
import type { Counts } from '#engine/server/notifications.ts';

type Json = Record<string, unknown>;
export type SentRoom = {
  cut: number;
  timelineCut: number;
  membership: string;
  membershipEvent: string;
  config: RoomConfig;
  members: Record<string, string>;
  metadata: Json;
};
const object = (v: unknown): Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {};
const bumpTypes = [
  'm.room.create',
  'm.room.message',
  'm.room.encrypted',
  'm.sticker',
  'm.call.invite',
  'm.poll.start',
  'm.beacon_info',
];

async function metadata(
  room: Room,
  viewer: Viewer,
  admission: StateAdmission,
  isDm: boolean,
  bump: number,
) {
  const rows = admission.rows;
  // Render before deriving display values: raw state is not erasure/redaction safe.
  const shown: Json[] = [];
  for (const row of rows) {
    if (!['m.room.member', 'm.room.name', 'm.room.avatar'].includes(row.type)) {
      continue;
    }
    const event = await renderStateEvent(room, row.eventId, viewer, {
      omitRoomId: true,
      bundleThreads: false,
      admission,
    });
    if (event !== null) shown.push(event);
  }
  const value = (type: string, key: string) => {
    const v = object(
      shown.find((e) => e.type === type && e.state_key === '')?.content,
    )[key];
    return typeof v === 'string' ? v : '';
  };
  const name = value('m.room.name', 'name');
  const members = shown.filter((e) => e.type === 'm.room.member');
  const candidates = members.filter((e) => e.state_key !== viewer.userId);
  const active = candidates.filter((e) =>
    ['join', 'invite'].includes(String(object(e.content).membership))
  );
  const rank = (e: Json) =>
    ['join', 'invite', 'leave', 'ban'].indexOf(
      String(object(e.content).membership),
    );
  const heroes = name
    ? []
    : (active.length
      ? active
      : candidates.filter((e) =>
        ['leave', 'ban'].includes(String(object(e.content).membership))
      ))
      .sort((a, b) =>
        rank(a) - rank(b) ||
        String(a.state_key).localeCompare(String(b.state_key))
      )
      .slice(0, 5).map((e) => {
        const c = object(e.content);
        return {
          user_id: e.state_key,
          ...(typeof c.displayname === 'string'
            ? { displayname: c.displayname }
            : {}),
          ...(typeof c.avatar_url === 'string'
            ? { avatar_url: c.avatar_url }
            : {}),
        };
      });
  return {
    name,
    avatar: value('m.room.avatar', 'url'),
    heroes,
    is_dm: isDm,
    bump_stamp: bump,
    joined_count:
      rows.filter((r) =>
        r.type === 'm.room.member' && r.content.membership === 'join'
      ).length,
    invited_count:
      rows.filter((r) =>
        r.type === 'm.room.member' && r.content.membership === 'invite'
      ).length,
  };
}

export async function roomPayloads(
  viewer: Viewer,
  selection: ListSelection,
  input: {
    eventCut: number;
    requestSince: number | null;
    direct: unknown;
    previous: Record<string, SentRoom>;
    notifications?: ReadonlyMap<string, Counts>;
  },
) {
  const sent = structuredClone(input.previous);
  const rooms: Record<string, Json> = {};
  const dm = new Set(
    Object.values(object(input.direct)).flatMap((v) =>
      Array.isArray(v) ? v : []
    ),
  );
  for (const [id, { candidate: c, config }] of selection.rooms) {
    const previous = input.previous[id];
    const room = await heldRoom(id);
    if (room === null && !c.prejoin && !c.departure) continue;
    if (c.cut > input.eventCut) {
      throw new Error('room exceeds captured event cut');
    }
    const prejoin = c.membership === 'invite' || c.membership === 'knock';
    const admission = !prejoin && !c.departure && room !== null
      ? await admitState(room, {
        userId: viewer.userId,
        ceiling: c.cut,
        point: { seq: c.cut },
      })
      : null;
    const delivery = admission === null || room === null
      ? null
      : await StateDelivery.capture(room, viewer.userId, {
        protocol: 'sliding',
        previous,
      }, Math.min(c.cut, admission.seq));
    const initial = delivery?.reset ?? previous === undefined;
    const entry: Json = { ...(initial ? { initial: true } : {}) };
    let meta: Json;
    let members: Record<string, string> = {};
    let requiredCoverage = config.requiredState;
    let effectiveLimit = config.timelineLimit;
    let end = c.cut;
    if (c.departure) {
      const departure = c.departure;
      const row: StateRow = {
        type: departure.type,
        stateKey: viewer.userId,
        eventId: c.eventId,
        content: departure.content,
        sender: departure.sender,
        originTs: departure.origin_server_ts,
      };
      const required = StateDelivery.departure(id, viewer.userId, row, {
        previous,
        required: config.requiredState,
      });
      const rendered = required.rows.length
        ? [renderPrejoinDeparture(departure, viewer.userId, 'client')]
        : [];
      if (rendered.length) entry.required_state = rendered;
      if (config.timelineLimit > 0 && c.seq > (previous?.timelineCut ?? 0)) {
        entry.timeline = [
          renderPrejoinDeparture(departure, viewer.userId, 'client'),
        ];
        entry.limited = false;
        entry.num_live =
          input.requestSince !== null && c.seq > input.requestSince ? 1 : 0;
        // A saved prejoin departure has no room-history pagination cursor.
      }
      ({ members, required: requiredCoverage } = required.rendered(rendered));
      meta = {
        bump_stamp: c.seq,
        ...(dm.has(id) || previous?.metadata.is_dm === true
          ? { is_dm: dm.has(id) }
          : {}),
      };
    } else if (prejoin) {
      const hints = c.prejoin
        ? [
          ...(await savedPrejoinDisplay(
            room,
            c.prejoin.state,
            viewer.userId,
            viewer,
          )).filter((e) =>
            !(e.type === 'm.room.member' && e.state_key === viewer.userId)
          ),
          stripPrejoin(c.prejoin.event),
        ]
        : room === null
        ? []
        : await prejoinDisplay(
          room,
          (await stateAtSeq(room, c.cut)).map((r) => r.eventId),
          viewer.userId,
          viewer,
        );
      meta = { invite_state: hints, ...(dm.has(id) ? { is_dm: true } : {}) };
    } else {
      if (room === null || admission === null || delivery === null) continue;
      end = Math.min(c.cut, admission.seq);
      const expanded = !initial && previous !== undefined &&
        config.timelineLimit > previous.config.timelineLimit;
      const window = config.timelineLimit === 0
        ? { rows: [], events: [], gap: false, trimmed: false }
        : await syncWindow(room, viewer, {
          since: initial || expanded ? 0 : previous!.timelineCut ?? 0,
          end,
          limit: config.timelineLimit,
        });
      const limited = window.gap || window.trimmed;
      if (config.timelineLimit > 0) {
        const start = window.rows[0];
        const cursor = start === undefined
          ? null
          : await room.tx((tx) => tx.segments.positionOf(start.event));
        entry.timeline = window.events;
        entry.limited = limited;
        entry.prev_batch = cursor === null
          ? formatStreamToken(end, 0, 0, 0, 0)
          : formatCursor(cursor);
        entry.num_live = input.requestSince === null
          ? 0
          : window.rows.filter((r) => r.seq > input.requestSince!).length;
      }
      if (expanded) entry.unstable_expanded_timeline = true;
      const required = delivery.required(admission, {
        required: config.requiredState,
        timeline: window.events,
        limited,
      });
      const state: Json[] = [];
      for (const row of required.rows) {
        const event = await renderStateEvent(room, row.eventId, viewer, {
          omitRoomId: true,
          admission,
        });
        if (event !== null) state.push(event);
      }
      if (state.length) entry.required_state = state;
      ({ members, required: requiredCoverage } = required.rendered(state));
      const bump = c.membership === 'join'
        ? (await syncWindow(room, viewer, {
          since: 0,
          end,
          limit: 1,
          filter: { types: bumpTypes },
        })).rows.at(-1)?.seq ?? c.seq
        : c.seq;
      meta = await metadata(room, viewer, admission, dm.has(id), bump);
      if (c.membership !== 'join') {
        delete meta.heroes;
        delete meta.joined_count;
        delete meta.invited_count;
      }
      // Synapse retains the effective history limit across unbroken decreases.
      if (!initial && !limited && previous) {
        effectiveLimit = Math.max(
          effectiveLimit,
          previous.config.timelineLimit,
        );
      }
    }
    // Optional wire omission must not erase the last value held by the client.
    meta.is_dm = dm.has(id);
    const counts = input.notifications?.get(id) ??
      { notification_count: 0, highlight_count: 0 };
    meta = { ...meta, ...counts };
    let changed = initial || eventsPresent(entry.timeline) ||
      eventsPresent(entry.required_state) ||
      entry.unstable_expanded_timeline === true;
    for (const [key, value] of Object.entries(meta)) {
      if (
        initial ||
        JSON.stringify(previous?.metadata[key]) !== JSON.stringify(value)
      ) {
        // Missing name/avatar/heroes/DM must clear previously delivered values.
        // Empty initial optional fields need not be sent.
        if (
          !initial ||
          (value !== '' && value !== false &&
            (!Array.isArray(value) || value.length))
        ) entry[key] = value;
        changed = true;
      }
    }
    if (changed) {
      rooms[id] = { ...entry, ...counts };
    }
    sent[id] = {
      cut: end,
      timelineCut: config.timelineLimit > 0 && !prejoin
        ? end
        : previous?.timelineCut ?? 0,
      membership: c.membership,
      membershipEvent: c.eventId,
      config: {
        requiredState: requiredCoverage,
        timelineLimit: effectiveLimit,
      },
      members,
      metadata: meta,
    };
  }
  return { rooms, sent };
}

function eventsPresent(events: unknown) {
  return Array.isArray(events) && events.length > 0;
}
