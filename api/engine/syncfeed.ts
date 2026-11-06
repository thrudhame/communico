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
import { onProjected } from '#engine/server/project.ts';
import { onEventStream } from '#engine/server/stream.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import {
  getPresence,
  onEphemeral,
  receiptsSince,
  setPresence,
  sharedUsers,
  streamMax,
} from '#engine/server/ephemeral.ts';
import {
  lastTypingChange,
  onTypingChange,
  sweepTyping,
  typingIn,
  typingSeq,
} from '#engine/typing.ts';

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
  const pdus = await room.tx((tx) => tx.events.list(raw.map((r) => r.event)));
  const typeMatches = (
    type: string,
    f: { types?: string[]; not_types?: string[] },
  ) =>
    (f.types === undefined || f.types.includes(type)) &&
    !f.not_types?.includes(type);
  const filtered = raw.filter((r) => {
    const pdu = pdus.get(r.event);
    return pdu !== undefined && typeMatches(pdu.type, i.filter.timeline);
  });
  const limit = i.filter.timeline.limit ?? 10;
  const trimmed = filtered.length > limit;
  const returned = trimmed ? filtered.slice(filtered.length - limit) : filtered;
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
    // A delta supplies state not already delivered by the timeline. Keep
    // the inclusive publication (fork resolution may change other keys),
    // but subtract only events actually rendered, after filtering/visibility.
    const inTimeline = new Set(events.map((event) => event.event_id));
    stateRows = atStart.filter((r) =>
      previous.get(r.type + '\0' + r.stateKey) !== r.eventId &&
      !inTimeline.has(r.eventId)
    );
  }
  const stateEvents: Record<string, unknown>[] = [];
  stateRows = stateRows.filter((r) => typeMatches(r.type, i.filter.state));
  if (i.filter.state.lazy_load_members) {
    const senders = new Set(events.map((ev) => String(ev.sender)));
    stateRows = stateRows.filter((r) =>
      r.type !== 'm.room.member' || senders.has(r.stateKey)
    );
  }
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
    const ephemeral: Record<string, unknown>[] = [];
    const typing = typingIn(room.id);
    if (
      i.since === null
        ? typing.userIds.length > 0
        : lastTypingChange(room.id) > i.since.tSeq
    ) {
      ephemeral.push({
        type: 'm.typing',
        content: { user_ids: typing.userIds },
      });
    }
    const receipts = await receiptsSince(
      app.server,
      room.id,
      i.since?.rSeq ?? 0,
    );
    if (receipts !== null) {
      ephemeral.push({ type: 'm.receipt', content: receipts });
    }
    entry.ephemeral = { events: ephemeral };
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

async function relevantChanged(i: SyncInputs): Promise<boolean> {
  if (i.since === null) return true;
  sweepTyping();
  const app = theApp();
  const rows = await app.server.query(
    `SELECT MAX(seq) AS m FROM (
       SELECT f.seq FROM feed f JOIN memberships m ON m.room = f.room WHERE m.user = ?
       UNION ALL SELECT seq FROM federation_invites WHERE user_id = ?
     )`,
    [i.userId, i.userId],
  );
  if (
    Number(rows[0].m ?? 0) > i.since.eSeq ||
    await accountDataMax(app.tenant, localpartOf(i.userId)) > i.since.aSeq
  ) return true;
  const joined = await roomsFor(app.server, i.userId);
  if (
    joined.some((m) =>
      m.membership === 'join' && lastTypingChange(m.roomId) > i.since!.tSeq
    )
  ) return true;
  const receipts = await app.server.query(
    "SELECT MAX(r.seq) AS m FROM receipts r JOIN memberships m ON m.room=r.room_id WHERE m.user=? AND m.membership='join'",
    [i.userId],
  );
  if (Number(receipts[0].m ?? 0) > i.since.rSeq) return true;
  for (const u of await sharedUsers(app.server, i.userId)) {
    if ((await getPresence(app.server, u)).seq > i.since.pSeq) return true;
  }
  return false;
}

async function waitForRelevant(i: SyncInputs): Promise<void> {
  if (i.since === null || i.timeoutMs <= 0) return;
  const app = theApp();
  const deadline = Date.now() + Math.min(i.timeoutMs, 30000);
  while (Date.now() < deadline) {
    let wake!: () => void;
    const changed = new Promise<void>((resolve) => {
      wake = resolve;
    });
    // Arm BEFORE reading maxima: a commit between the read and await
    // remains signalled. Unrelated writes only trigger a relevance recheck.
    const removers = [
      onTypingChange(() => wake()),
      onEphemeral((server) => {
        if (server.path === app.server.path) wake();
      }),
      onProjected((store) => {
        if (store === app.store) wake();
      }),
      onEventStream((path) => {
        if (path === app.server.path) wake();
      }),
      onTenantStream((store, tenant) => {
        if (store === app.store && tenant === app.tenant.serverName) wake();
      }),
    ];
    const timer = setTimeout(
      wake,
      Math.min(500, Math.max(0, deadline - Date.now())),
    );
    try {
      if (await relevantChanged(i)) return;
      await changed;
    } finally {
      clearTimeout(timer);
      for (const remove of removers) remove();
    }
  }
}

export async function syncFor(i: SyncInputs): Promise<Record<string, unknown>> {
  const app = theApp();
  const lp = localpartOf(i.userId);
  if (i.setPresence !== undefined) {
    await setPresence(app.server, i.userId, i.setPresence);
  }
  sweepTyping();
  await waitForRelevant(i);
  sweepTyping();
  const now: StreamToken = {
    eSeq: await eventStreamMax(app.server),
    pSeq: await streamMax(app.server, 'presence'),
    tSeq: typingSeq(),
    rSeq: await streamMax(app.server, 'receipts'),
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
      const receipts = await app.server.query(
        'SELECT 1 FROM receipts WHERE room_id=? AND seq>? LIMIT 1',
        [m.roomId, i.since.rSeq],
      );
      if (
        !changed.length && !receipts.length &&
        lastTypingChange(m.roomId) <= i.since.tSeq
      ) continue;
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
  const presenceEvents = new Map<string, Record<string, unknown>>();
  const shared = await sharedUsers(app.server, i.userId);
  const includePresence = async (u: string) => {
    const row = await getPresence(app.server, u);
    const content: Record<string, unknown> = { presence: row.presence };
    if (row.statusMsg !== null) content.status_msg = row.statusMsg;
    if (row.presence !== 'offline' && row.lastActiveMs > 0) {
      content.last_active_ago = Math.max(0, Date.now() - row.lastActiveMs);
    }
    presenceEvents.set(u, { type: 'm.presence', sender: u, content });
  };
  for (const u of shared) {
    if (
      i.since === null ||
      (await getPresence(app.server, u)).seq > i.since.pSeq ||
      allJoiners.has(i.userId)
    ) await includePresence(u);
  }
  if (i.since !== null) {
    for (const u of allJoiners) {
      await includePresence(u);
    }
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
    presence: { events: [...presenceEvents.values()] },
    account_data: { events: accountData },
    to_device: { events: [] },
    device_lists: { changed: deviceChanged, left: deviceLeft },
    device_one_time_keys_count: {},
  };
}
