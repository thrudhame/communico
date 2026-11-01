// doltgres sync assembly on room publications + tenant streams. History
// has no feed position and cannot enter a new timeline. R6 cuts use the
// published state, never the last event's own DAG state.
import { theApp } from '#engine/app.ts';
import { heldRoom, stateAtSeq, type StateRow } from '#engine/client/read.ts';
import { renderEvent } from '#engine/client/render.ts';
import { formatStreamToken, type StreamToken } from '#engine/client/tokens.ts';
import type { Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import { feedAfter, roomsFor } from '#engine/server/read.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import {
  accountDataMax,
  getAccountData,
  listGlobalAccountData,
  listGlobalAccountDataSince,
  listRoomAccountData,
} from '#engine/tenant/accountdata.ts';
import { pushStreamSeq, rulesetFor } from '#engine/tenant/pushrules.ts';
import type { RoomFilter } from '#engine/tenant/filters.ts';

export interface SyncInputs {
  userId: string;
  deviceId: string | null;
  since: StreamToken | null;
  timeoutMs: number;
  filter: RoomFilter;
  fullState: boolean;
  setPresence?: string;
}

const strippedTypes = new Set([
  'm.room.create',
  'm.room.join_rules',
  'm.room.name',
  'm.room.topic',
  'm.room.avatar',
  'm.room.canonical_alias',
  'm.room.encryption',
]);
const stripped = (row: StateRow) => ({
  type: row.type,
  state_key: row.stateKey,
  content: row.content,
  sender: row.sender,
  ...(row.type === 'm.room.create' ? { origin_server_ts: row.originTs } : {}),
});

async function roomTimeline(
  room: Room,
  i: SyncInputs,
  now: StreamToken,
  end: number,
  summary: boolean,
) {
  const app = theApp();
  const raw = await feedAfter(
    app.server,
    room.id,
    i.since?.eSeq ?? 0,
    Number.MAX_SAFE_INTEGER,
    end,
  );
  const limit = 10;
  const trimmed = raw.length > limit;
  const returned = trimmed ? raw.slice(-limit) : raw;
  const events: Record<string, unknown>[] = [];
  for (const row of returned) {
    const pduRow = await room.tx((tx) => tx.events.get(row.event));
    if (pduRow === null) continue;
    const pdu = JSON.parse(pduRow.pdu) as Pdu;
    const at = await stateAtSeq(room, row.seq, row.stay);
    const membership = at.find((s) =>
      s.type === 'm.room.member' && s.stateKey === i.userId
    )?.content.membership ?? 'leave';
    const hv = at.find((s) =>
      s.type === 'm.room.history_visibility'
    )?.content.history_visibility ?? 'shared';
    if (
      !(pdu.type === 'm.room.member' && pdu.state_key === i.userId) &&
      hv !== 'world_readable' && membership !== 'join' && hv !== 'shared' &&
      !(hv === 'invited' && membership === 'invite')
    ) continue;
    const event = await renderEvent(room, row.event, {
      userId: i.userId,
      deviceId: i.deviceId,
      tenant: app.tenant,
      membership: String(membership),
    }, { omitRoomId: true });
    if (event !== null) events.push(event);
  }
  const start = returned[0];
  const atStart = await stateAtSeq(room, start?.seq ?? end, start?.stay);
  let stateRows = atStart;
  if (i.since !== null && !i.fullState) {
    const previous = new Map(
      (await stateAtSeq(room, i.since.eSeq, start?.stay)).map((
        r,
      ) => [r.type + '\0' + r.stateKey, r.eventId]),
    );
    stateRows = atStart.filter((r) =>
      previous.get(r.type + '\0' + r.stateKey) !== r.eventId
    );
  }
  const stateEvents: Record<string, unknown>[] = [];
  for (const row of stateRows) {
    const ev = await renderEvent(room, row.eventId, {
      userId: i.userId,
      deviceId: i.deviceId,
      tenant: app.tenant,
    }, { omitRoomId: true });
    if (ev !== null) stateEvents.push(ev);
  }
  const prevE = trimmed && returned.length ? returned[0].seq - 1 : end;
  const entry: Record<string, unknown> = {
    state: { events: stateEvents },
    timeline: {
      events,
      limited: raw.length > returned.length,
      prev_batch: formatStreamToken(
        prevE,
        now.pSeq,
        now.tSeq,
        now.rSeq,
        now.aSeq,
      ),
    },
    ephemeral: { events: [] },
    account_data: { events: [] },
    unread_notifications: {},
  };
  if (summary) {
    const members = await app.server.query(
      "SELECT user, membership FROM memberships WHERE room = ? AND membership IN ('join','invite') ORDER BY CASE membership WHEN 'join' THEN 0 ELSE 1 END, user",
      [room.id],
    );
    const heroes = members.filter((r) => r.user !== i.userId).slice(0, 5).map((
      r,
    ) => String(r.user));
    entry.summary = {
      'm.joined_member_count': members.filter((r) =>
        r.membership === 'join'
      ).length,
      'm.invited_member_count': members.filter((r) =>
        r.membership === 'invite'
      ).length,
      ...(heroes.length ? { 'm.heroes': heroes } : {}),
    };
    entry.account_data = {
      events: await listRoomAccountData(
        app.tenant,
        localpartOf(i.userId),
        room.id,
      ),
    };
  }
  const joiners: string[] = [], leavers: string[] = [];
  for (const row of raw) {
    const pdu = await room.tx(async (tx) => {
      const e = await tx.events.get(row.event);
      return e === null ? null : JSON.parse(e.pdu) as Pdu;
    });
    if (pdu?.type !== 'm.room.member') continue;
    if (pdu.content.membership === 'join') joiners.push(String(pdu.state_key));
    if (['leave', 'ban'].includes(String(pdu.content.membership))) {
      leavers.push(String(pdu.state_key));
    }
  }
  return { entry, joiners, leavers };
}

export async function syncFor(i: SyncInputs): Promise<Record<string, unknown>> {
  const app = theApp();
  const lp = localpartOf(i.userId);
  const now: StreamToken = {
    eSeq: await eventStreamMax(app.server),
    pSeq: 0,
    tSeq: 0,
    rSeq: 0,
    aSeq: await accountDataMax(app.tenant, lp),
  };
  const nextBatch = formatStreamToken(
    now.eSeq,
    now.pSeq,
    now.tSeq,
    now.rSeq,
    now.aSeq,
  );
  const memberships = await roomsFor(app.server, i.userId);
  const join: Record<string, unknown> = {},
    invite: Record<string, unknown> = {},
    leave: Record<string, unknown> = {};
  const ignored = await getAccountData(
    app.tenant,
    lp,
    '',
    'm.ignored_user_list',
  ) as { ignored_users?: Record<string, unknown> } | null;
  const ignoredUsers = new Set(Object.keys(ignored?.ignored_users ?? {}));
  // OOB rows have their own authoritative owner, never synthetic room files.
  const oob = await app.server.query(
    'SELECT * FROM federation_invites WHERE user_id = ? AND seq <= ? ORDER BY seq',
    [i.userId, now.eSeq],
  );
  const oobRooms = new Set<string>();
  for (const row of oob) {
    if (row.status === 'joined') continue;
    const roomId = String(row.room_id);
    oobRooms.add(roomId);
    const event = JSON.parse(String(row.event_json)) as Record<string, unknown>;
    if (ignoredUsers.has(String(event.sender))) continue;
    const events = [...JSON.parse(String(row.invite_room_state)), {
      type: event.type,
      state_key: event.state_key,
      content: event.content,
      sender: event.sender,
    }];
    if (row.status === 'pending') invite[roomId] = { invite_state: { events } };
    else if (
      i.since === null ? i.filter.includeLeave : Number(row.seq) > i.since.eSeq
    ) {
      leave[roomId] = {
        timeline: { events: [], limited: false, prev_batch: '' },
        state: { events },
      };
    }
  }
  const allJoiners = new Set<string>(), allLeavers = new Set<string>();
  for (const m of memberships) {
    if (oobRooms.has(m.roomId)) continue;
    const room = await heldRoom(m.roomId);
    if (room === null) continue;
    if (m.membership === 'invite') {
      const at = await stateAtSeq(room, m.seq);
      const member = at.find((r) =>
        r.type === 'm.room.member' && r.stateKey === i.userId
      );
      if (member && ignoredUsers.has(member.sender)) continue;
      invite[m.roomId] = {
        invite_state: {
          events: at.filter((r) =>
            strippedTypes.has(r.type) ||
            r.type === 'm.room.member' && r.stateKey === i.userId
          ).map(stripped),
        },
      };
      continue;
    }
    const left = m.membership === 'leave' || m.membership === 'ban';
    if (left) {
      const purgeable = await app.server.query(
        'SELECT 1 FROM directory WHERE room_id = ? AND purgeable_ms IS NOT NULL',
        [m.roomId],
      );
      if (
        (m.forgotten || purgeable.length) && (i.since === null || i.fullState)
      ) continue;
      if (!(i.since === null ? i.filter.includeLeave : m.seq > i.since.eSeq)) {
        continue;
      }
    } else if (i.since !== null && !i.fullState) {
      const changed = await feedAfter(
        app.server,
        m.roomId,
        i.since.eSeq,
        1,
        now.eSeq,
      );
      if (!changed.length) continue;
    }
    const result = await roomTimeline(
      room,
      i,
      now,
      left ? m.seq : now.eSeq,
      !left,
    );
    (left ? leave : join)[m.roomId] = result.entry;
    for (const u of result.joiners) allJoiners.add(u);
    for (const u of result.leavers) allLeavers.add(u);
  }
  const deviceChanged: string[] = [], deviceLeft: string[] = [];
  if (i.since !== null) {
    deviceChanged.push(...allJoiners);
    for (const u of allLeavers) {
      const shared = await app.server.query(
        "SELECT 1 FROM memberships a JOIN memberships b ON a.room = b.room WHERE a.user = ? AND b.user = ? AND a.membership = 'join' AND b.membership = 'join' LIMIT 1",
        [i.userId, u],
      );
      if (!shared.length) deviceLeft.push(u);
    }
  }
  const accountData: { type: string; content: unknown }[] = i.since === null
    ? await listGlobalAccountData(app.tenant, lp)
    : await listGlobalAccountDataSince(app.tenant, lp, i.since.aSeq);
  if (i.since === null || await pushStreamSeq(app.tenant, lp) > i.since.aSeq) {
    accountData.push({
      type: 'm.push_rules',
      content: { global: await rulesetFor(app.tenant, lp) },
    });
  }
  return {
    next_batch: nextBatch,
    rooms: { join, invite, leave },
    presence: { events: [] },
    account_data: { events: accountData },
    to_device: { events: [] },
    device_lists: { changed: deviceChanged, left: deviceLeft },
    device_one_time_keys_count: {},
  };
}
