// doltgres sync assembly on room publications + tenant streams. History
// has no feed position and cannot enter a new timeline. R6 cuts use the
// published state, never the last event's own DAG state.
import { theApp } from '#engine/app.ts';
import { heldRoom, stateAtSeq } from '#engine/client/read.ts';
import {
  renderEvent,
  renderPrejoinDeparture,
  renderStateEvent,
} from '#engine/client/render.ts';
import { inviteOf, prejoinDeparture } from '#engine/federation/invites.ts';
import {
  encodeStreamToken,
  formatStreamToken,
  type StreamToken,
} from '#engine/client/tokens.ts';
import { config } from '#engine/config.ts';
import {
  prejoinDisplay,
  savedPrejoinDisplay,
} from '#engine/federation/prejoin.ts';
import { visiblePrejoin } from '#engine/server/prejoin.ts';
import { deviceListsBetween, deviceStreamMax } from '#engine/server/e2ee.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import type { Room } from '#engine/room/index.ts';
import { formatCursor } from '#engine/room/segments.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  feedAfter,
  feedBefore,
  type FeedRow,
  roomsFor,
} from '#engine/server/read.ts';
import {
  notificationSnapshot,
  syncNotificationCounts,
} from '#engine/server/notifications.ts';
import type { Row } from '#engine/store/ffi.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import {
  accountDataMax,
  getAccountData,
  listGlobalAccountData,
  listGlobalAccountDataSince,
} from '#engine/tenant/accountdata.ts';
import { pushStreamSeq, rulesetFor } from '#engine/tenant/pushrules.ts';
import {
  eventMatchesRoomEventFilter,
  filterEvents,
  type RoomFilter,
} from '#engine/tenant/filters.ts';
import { onProjected } from '#engine/server/project.ts';
import { onEventStream } from '#engine/server/stream.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import {
  getPresence,
  onEphemeral,
  receiptRoomsSince,
  receiptsSince,
  setPresenceValue,
  sharedUsers,
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
  deviceGeneration?: number;
  since: StreamToken | null;
  timeoutMs: number;
  filter: RoomFilter;
  fullState: boolean;
  useStateAfter?: boolean;
  setPresence?: string;
}

async function roomTimeline(
  room: Room,
  i: SyncInputs,
  now: StreamToken,
  end: number,
  summary: boolean,
  snapshot: {
    receipts: Record<string, unknown>[];
    members: Row[];
    notifications: ReturnType<typeof syncNotificationCounts>;
    accountData: { type: string; content: unknown }[];
  },
) {
  const app = theApp();
  const limit = i.filter.timeline.limit ?? 10;
  const eligible: {
    row: FeedRow;
    event: Record<string, unknown>;
  }[] = [];
  let cursor = end;
  let scanned = 0;
  let more = true;
  let gap = false;
  let newestStay: number | undefined;
  // Bound hydration as well as rendering. Walk newest first until one
  // eligible lookahead proves truncation; hidden rows never consume slots.
  while (more && !gap && eligible.length <= limit) {
    const page = await feedBefore(
      app.server,
      room.id,
      i.since?.eSeq ?? 0,
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
        ) {
          boundaries.add(row.event);
        }
      }
      return { stored, boundaries };
    });
    for (const row of page) {
      newestStay ??= row.stay;
      if (row.stay !== newestStay) {
        gap = true;
        break;
      }
      scanned++;
      // An imported before-state is an explicit missing live-history boundary.
      // Retain its event, but never splice the older feed across it, including
      // when the boundary event itself is hidden by a client filter.
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
          i.filter.timeline,
        )
      ) {
        if (gap) break;
        continue;
      }
      const at = await stateAtSeq(room, row.seq, row.stay);
      const membership = at.find((s) =>
        s.type === 'm.room.member' && s.stateKey === i.userId
      )?.content.membership ?? 'leave';
      const event = await renderEvent(room, row.event, {
        userId: i.userId,
        deviceId: i.deviceId,
        tenant: app.tenant,
        membership: String(membership),
      }, { omitRoomId: true, eventFormat: i.filter.eventFormat });
      if (event !== null) eligible.unshift({ row, event });
      if (gap || eligible.length > limit) break;
    }
  }
  const trimmed = eligible.length > limit;
  const selected = limit === 0
    ? []
    : trimmed
    ? eligible.slice(eligible.length - limit)
    : eligible;
  const returned = selected.map((item) => item.row);
  const events = selected.map((item) => item.event);
  const limited = gap || more || scanned > returned.length;
  const start = returned[0];
  const atStart = await stateAtSeq(
    room,
    i.useStateAfter ? end : start?.seq ?? end,
    i.useStateAfter ? undefined : start?.stay,
  );
  let stateRows = atStart;
  let previous = new Map<string, string>();
  if (i.since !== null) {
    previous = new Map(
      (await stateAtSeq(
        room,
        i.since.eSeq,
        i.useStateAfter ? undefined : start?.stay,
      )).map((
        r,
      ) => [r.type + '\0' + r.stateKey, r.eventId]),
    );
  }
  if (i.since !== null && !i.fullState) {
    // Legacy deltas omit state already in the timeline. state_after is the
    // complete end-cut delta: clients must ignore timeline state in this mode.
    // Both read resolved publications, not the trigger event's DAG state.
    const inTimeline = new Set(events.map((event) => event.event_id));
    stateRows = atStart.filter((r) =>
      previous.get(r.type + '\0' + r.stateKey) !== r.eventId &&
      (i.useStateAfter || !inTimeline.has(r.eventId))
    );
  }
  const stateEvents: Record<string, unknown>[] = [];
  if (i.filter.state.lazy_load_members || i.filter.timeline.lazy_load_members) {
    const senders = new Set(events.map((ev) => String(ev.sender)));
    const mandatoryOwn = i.since === null || i.fullState ||
      atStart.some((r) =>
        r.type === 'm.room.member' && r.stateKey === i.userId &&
        r.content.membership === 'join' &&
        previous.get(r.type + '\0' + r.stateKey) !== r.eventId
      );
    const selectedIds = new Set(stateRows.map((r) => r.eventId));
    // Timeline senders need their membership even when unchanged since the
    // previous cut. Gap membership changes are mandatory, not lazy hints.
    stateRows = atStart.filter((r) =>
      r.type !== 'm.room.member'
        ? selectedIds.has(r.eventId)
        : senders.has(r.stateKey) ||
          (mandatoryOwn && r.stateKey === i.userId) ||
          (limited && i.since !== null &&
            previous.get(r.type + '\0' + r.stateKey) !== r.eventId)
    );
  }
  stateRows = filterEvents(stateRows, i.filter.state, room.id);
  for (const row of stateRows) {
    const ev = await renderStateEvent(room, row.eventId, {
      userId: i.userId,
      deviceId: i.deviceId,
      tenant: app.tenant,
    }, { omitRoomId: true, eventFormat: i.filter.eventFormat });
    if (ev !== null) stateEvents.push(ev);
  }
  const prevE = trimmed && returned.length ? returned[0].seq - 1 : end;
  const paginationCursor = limited && start !== undefined
    ? await room.tx((tx) => tx.segments.positionOf(start.event))
    : null;
  const entry: Record<string, unknown> = {
    [i.useStateAfter ? 'state_after' : 'state']: { events: stateEvents },
    timeline: {
      events,
      limited,
      prev_batch: paginationCursor === null
        ? formatStreamToken(
          prevE,
          now.pSeq,
          now.tSeq,
          now.rSeq,
          now.aSeq,
          now.dSeq,
          now.mSeq,
          now.kSeq,
          now.nSeq,
        )
        : formatCursor(paginationCursor),
    },
    ephemeral: { events: [] },
    account_data: { events: [] },
    ...snapshot.notifications,
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
    const receipts = snapshot.receipts;
    for (const content of receipts) {
      ephemeral.push({ type: 'm.receipt', content });
    }
    entry.ephemeral = {
      events: filterEvents(
        ephemeral as { type: string; content: unknown }[],
        i.filter.ephemeral,
        room.id,
      ),
    };
    const members = snapshot.members;
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
      events: filterEvents(
        snapshot.accountData,
        i.filter.roomAccountData,
        room.id,
      ),
    };
  }
  // Presence needs new current joiners, independently of timeline filtering.
  // The captured projection already owns membership and its change sequence.
  const joiners = i.since === null
    ? []
    : snapshot.members.filter((row) =>
      row.membership === 'join' && Number(row.seq) > i.since!.eSeq &&
      Number(row.seq) <= end
    ).map((row) => String(row.user));
  return { entry, joiners };
}

async function relevantChanged(
  i: SyncInputs,
  device: DeviceIdentity | null,
): Promise<boolean> {
  if (i.since === null) return true;
  sweepTyping();
  const app = theApp();
  if (
    (await notificationSnapshot(app.server, i.userId, i.since.nSeq ?? 0))
      .changed.size
  ) return true;
  const lists = await deviceListsBetween(
    app.server,
    i.userId,
    i.since.dSeq,
    await deviceStreamMax(app.server),
    'sync',
  );
  if (lists.changed.length || lists.left.length) return true;
  if (
    device !== null &&
    await app.tenant.tx(async (tx) =>
      await tx.toDevice.pending(device) ||
      (await tx.e2ee.status(device)).seq > i.since!.kSeq
    )
  ) return true;
  const rows = await app.server.query(
    `SELECT MAX(seq) AS m FROM (
       SELECT f.seq FROM feed f JOIN memberships m ON m.room = f.room WHERE m.user = ?
       UNION ALL SELECT seq FROM prejoin_memberships p WHERE user_id = ? AND status NOT IN ('attempting','failed-attempt') AND ${
      visiblePrejoin('p')
    }
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
  if (
    (await receiptRoomsSince(app.server, i.userId, i.since.rSeq)).size > 0
  ) return true;
  for (const u of await sharedUsers(app.server, i.userId)) {
    if ((await getPresence(app.server, u)).seq > i.since.pSeq) return true;
  }
  return false;
}

async function waitForRelevant(
  i: SyncInputs,
  device: DeviceIdentity | null,
): Promise<void> {
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
      if (await relevantChanged(i, device)) return;
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
  const device: DeviceIdentity | null =
    i.deviceId === null || i.deviceGeneration === undefined
      ? null
      : { localpart: lp, deviceId: i.deviceId, generation: i.deviceGeneration };
  if (device !== null) {
    await app.tenant.tx((tx) => tx.toDevice.acknowledge(device, i.since));
  }
  const deviceHead = await deviceStreamMax(app.server);
  if (i.since !== null && i.since.dSeq > deviceHead) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'future device token');
  }
  if (i.setPresence !== undefined) {
    await setPresenceValue(app.server, i.userId, i.setPresence);
  }
  sweepTyping();
  await waitForRelevant(i, device);
  sweepTyping();
  // One server transaction selects events, receipts, memberships and counts.
  // Rendering afterward may be slow, but cannot mix a later count/receipt cut.
  const snapshot = await app.server.tx(async (tx) => {
    const counters = new Map(
      (await tx.query('SELECT name,value FROM counters')).map((
        r,
      ) => [String(r.name), Number(r.value)]),
    );
    const memberships = await roomsFor(tx, i.userId);
    const notifications = await notificationSnapshot(
      tx,
      i.userId,
      i.since?.nSeq ?? 0,
    );
    const rooms = new Map<
      string,
      { receipts: Record<string, unknown>[]; members: Row[] }
    >();
    for (const membership of memberships) {
      rooms.set(membership.roomId, {
        receipts: await receiptsSince(
          tx,
          membership.roomId,
          i.userId,
          i.since?.rSeq ?? 0,
        ),
        members: await tx.query(
          "SELECT user,membership,seq FROM memberships WHERE room=? AND membership IN ('join','invite') ORDER BY CASE membership WHEN 'join' THEN 0 ELSE 1 END,user",
          [membership.roomId],
        ),
      });
    }
    const oob = await tx.query(
      `SELECT * FROM prejoin_memberships p WHERE user_id=? AND ${
        visiblePrejoin('p')
      } ORDER BY seq`,
      [i.userId],
    );
    return { counters, memberships, notifications, rooms, oob };
  });
  const now: StreamToken = {
    eSeq: snapshot.counters.get('events') ?? 0,
    pSeq: snapshot.counters.get('presence') ?? 0,
    tSeq: typingSeq(),
    rSeq: snapshot.counters.get('receipts') ?? 0,
    aSeq: await accountDataMax(app.tenant, lp),
    dSeq: snapshot.counters.get('devices') ?? 0,
    mSeq: 0,
    kSeq: 0,
    nSeq: snapshot.counters.get('notifications') ?? 0,
  };
  const delivery = device === null
    ? { events: [], token: now, pools: { counts: {}, unused: [] } }
    : await app.tenant.tx(async (tx) => {
      const pools = await tx.e2ee.status(device);
      const delivered = await tx.toDevice.deliver(device, {
        ...now,
        kSeq: pools.seq,
      }, config().e2ee);
      return { ...delivered, pools };
    });
  const nextBatch = encodeStreamToken(delivery.token);
  const roomAccountData = await app.tenant.tx((tx) =>
    tx.accountData.roomsSince(lp, i.since?.aSeq ?? 0, now.aSeq)
  );
  const memberships = snapshot.memberships;
  const receiptRooms = new Set(
    [...snapshot.rooms].filter(([, r]) => r.receipts.length).map(([id]) => id),
  );
  const join: Record<string, unknown> = {},
    invite: Record<string, unknown> = {},
    knock: Record<string, unknown> = {},
    leave: Record<string, unknown> = {};
  const roomIncluded = (id: string) =>
    (!i.filter.rooms || i.filter.rooms.includes(id)) &&
    !i.filter.notRooms?.includes(id);
  const ignored = await getAccountData(
    app.tenant,
    lp,
    '',
    'm.ignored_user_list',
  ) as { ignored_users?: Record<string, unknown> } | null;
  const ignoredUsers = new Set(Object.keys(ignored?.ignored_users ?? {}));
  // OOB rows have their own authoritative owner, never synthetic room files.
  const oob = snapshot.oob;
  const oobRooms = new Set<string>();
  for (const row of oob) {
    if (
      ['joined', 'attempting', 'failed-attempt'].includes(String(row.status))
    ) continue;
    const roomId = String(row.room_id);
    oobRooms.add(roomId);
    if (!roomIncluded(roomId)) continue;
    if (i.since !== null && !i.fullState && Number(row.seq) <= i.since.eSeq) {
      continue;
    }
    const event = JSON.parse(String(row.event_json)) as Record<string, unknown>;
    if (row.status === 'pending' && ignoredUsers.has(String(event.sender))) {
      continue;
    }
    if (row.status !== 'pending') {
      if (
        i.since === null
          ? i.filter.includeLeave
          : Number(row.seq) > i.since.eSeq
      ) {
        const departure = renderPrejoinDeparture(
          await prejoinDeparture(inviteOf(row), {
            server: app.server,
            signer: app.tenant.signer(),
          }),
          i.userId,
        );
        leave[roomId] = {
          timeline: { events: [], limited: false, prev_batch: '' },
          [i.useStateAfter ? 'state_after' : 'state']: {
            events: filterEvents([departure], i.filter.state, roomId),
          },
        };
      }
      continue;
    }
    const saved = JSON.parse(String(row.invite_room_state)) as Record<
      string,
      unknown
    >[];
    const events = [
      ...(await savedPrejoinDisplay(await heldRoom(roomId), saved, i.userId, {
        userId: i.userId,
        tenant: app.tenant,
      })).filter((e) =>
        !(e.type === 'm.room.member' && e.state_key === i.userId)
      ),
      {
        type: event.type,
        state_key: event.state_key,
        content: event.content,
        sender: event.sender,
      },
    ];
    if (row.status === 'pending' && row.kind === 'knock') {
      knock[roomId] = { knock_state: { events } };
    } else if (row.status === 'pending') {
      invite[roomId] = { invite_state: { events } };
    }
  }
  const allJoiners = new Set<string>();
  for (const m of memberships) {
    if (oobRooms.has(m.roomId) || !roomIncluded(m.roomId)) continue;
    const room = await heldRoom(m.roomId);
    if (room === null) continue;
    if (m.membership === 'invite' || m.membership === 'knock') {
      if (i.since !== null && !i.fullState && m.seq <= i.since.eSeq) continue;
      const at = await stateAtSeq(room, m.seq);
      const member = at.find((r) =>
        r.type === 'm.room.member' && r.stateKey === i.userId
      );
      if (member && ignoredUsers.has(member.sender)) continue;
      const section = m.membership === 'knock' ? knock : invite;
      section[m.roomId] = {
        [m.membership === 'knock' ? 'knock_state' : 'invite_state']: {
          events: await prejoinDisplay(
            room,
            at.map((r) => r.eventId),
            i.userId,
            {
              userId: i.userId,
              tenant: app.tenant,
            },
          ),
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
      if (
        !changed.length && !receiptRooms.has(m.roomId) &&
        !roomAccountData.has(m.roomId) &&
        !snapshot.notifications.changed.has(m.roomId) &&
        lastTypingChange(m.roomId) <= i.since.tSeq
      ) continue;
    }
    const result = await roomTimeline(
      room,
      i,
      delivery.token,
      left ? m.seq : now.eSeq,
      !left,
      {
        ...snapshot.rooms.get(m.roomId)!,
        accountData: roomAccountData.get(m.roomId) ?? [],
        notifications: syncNotificationCounts(
          snapshot.notifications.rooms.get(m.roomId),
          i.filter.timeline.unread_thread_notifications === true,
        ),
      },
    );
    (left ? leave : join)[m.roomId] = result.entry;
    for (const u of result.joiners) allJoiners.add(u);
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
  const deviceLists = i.since === null
    ? { changed: [], left: [] }
    : await deviceListsBetween(
      app.server,
      i.userId,
      i.since.dSeq,
      now.dSeq,
      'sync',
    );
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
    rooms: { join, invite, knock, leave },
    presence: {
      events: filterEvents(
        [...presenceEvents.values()] as {
          type: string;
          sender: string;
          content: unknown;
        }[],
        i.filter.presence,
      ),
    },
    account_data: { events: filterEvents(accountData, i.filter.accountData) },
    to_device: { events: delivery.events },
    device_lists: deviceLists,
    device_one_time_keys_count: delivery.pools.counts,
    device_unused_fallback_key_types: delivery.pools.unused,
  };
}
