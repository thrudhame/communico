// doltgres sync assembly on room publications + tenant streams. History
// has no feed position and cannot enter a new timeline. R6 cuts use the
// published state, never the last event's own DAG state.
import { theApp } from '#engine/app.ts';
import { heldRoom, stateAtSeq } from '#engine/client/read.ts';
import { admitState } from '#engine/client/state-admission.ts';
import { StateDelivery } from '#engine/client/state-delivery.ts';
import { syncWindow } from '#engine/client/sync-window.ts';
import {
  renderPrejoinDeparture,
  renderStateEvent,
} from '#engine/client/render.ts';
import { inviteOf, prejoinDeparture } from '#engine/federation/invites.ts';
import {
  boundFutureToken,
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
import {
  deviceListsBetween,
  deviceListSnapshot,
  deviceStreamMax,
} from '#engine/server/e2ee.ts';
import { recoveryState } from '#engine/server/recovery.ts';
import { syncStreamHeads } from '#engine/server/stream.ts';
import type { DeviceIdentity } from '#engine/tenant/devices.ts';
import type { Room } from '#engine/room/index.ts';
import { formatCursor } from '#engine/room/segments.ts';
import { feedAfter, feedBefore, roomsFor } from '#engine/server/read.ts';
import {
  notificationChanged,
  notificationSnapshot,
  syncNotificationCounts,
} from '#engine/server/notifications.ts';
import type { Row } from '#engine/store/ffi.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import {
  accountDataMax,
  captureAccountData,
  getAccountData,
} from '#engine/tenant/accountdata.ts';
import { filterEvents, type RoomFilter } from '#engine/tenant/filters.ts';
import { waitForSync } from '#engine/sync-wait.ts';
import {
  getPresence,
  receiptRoomsSince,
  receiptSnapshot,
  setPresenceValue,
  sharedUsers,
} from '#engine/server/ephemeral.ts';
import {
  captureTyping,
  lastTypingChange,
  sweepTyping,
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
  stateAfterKey?: 'state_after' | 'org.matrix.msc4222.state_after';
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
    typing: { userIds: string[]; changed: number };
  },
) {
  const app = theApp();
  const limit = i.filter.timeline.limit ?? 10;
  const { rows: returned, events, gap, trimmed } = await syncWindow(room, {
    userId: i.userId,
    deviceId: i.deviceId,
    tenant: app.tenant,
  }, {
    since: i.since?.eSeq ?? 0,
    end,
    limit,
    filter: i.filter.timeline,
    eventFormat: i.filter.eventFormat,
  });
  let joinGap = false;
  const since = i.since?.eSeq;
  const delivery = await StateDelivery.capture(room, i.userId, {
    protocol: 'ordinary',
    since: since ?? null,
    fullState: i.fullState,
  }, end);
  if (
    summary && since !== undefined &&
    snapshot.members.some((row) =>
      row.user === i.userId && Number(row.seq) > since
    )
  ) {
    if (delivery.participationReset) {
      // A global since token does not mean this newly joined client has seen
      // the room's earlier history. Keep that real discontinuity paginatable.
      joinGap = (await feedBefore(app.server, room.id, 0, since, 1))
        .length > 0;
    }
  }
  const limited = gap || trimmed || joinGap;
  const start = returned[0];
  const admission = await admitState(room, {
    userId: i.userId,
    ceiling: end,
    point: {
      seq: i.useStateAfter ? end : start?.seq ?? end,
      ...(i.useStateAfter || start === undefined ? {} : { stay: start.stay }),
    },
  });
  const prepared = delivery.ordinary(admission, {
    timeline: events,
    limited,
    filter: i.filter,
    stateAfter: i.useStateAfter === true,
    incremental: i.since !== null,
    fullState: i.fullState,
  });
  const stateEvents: Record<string, unknown>[] = [];
  for (const row of prepared.rows) {
    const ev = await renderStateEvent(room, row.eventId, {
      userId: i.userId,
      deviceId: i.deviceId,
      tenant: app.tenant,
    }, { omitRoomId: true, eventFormat: i.filter.eventFormat, admission });
    if (ev !== null) stateEvents.push(ev);
  }
  const prevE = trimmed && returned.length ? returned[0].seq - 1 : end;
  // Like Synapse, an untrimmed window retains its captured end cut. Only a
  // limited window needs a before-event cursor for the missing older history.
  const paginationCursor = limited && start !== undefined
    ? await room.tx((tx) => tx.segments.positionOf(start.event))
    : null;
  const entry: Record<string, unknown> = {
    [i.useStateAfter ? (i.stateAfterKey ?? 'state_after') : 'state']: {
      events: stateEvents,
    },
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
          now.epoch,
        )
        : formatCursor(paginationCursor),
    },
    ephemeral: { events: [] },
    account_data: { events: [] },
    ...snapshot.notifications,
  };
  if (summary) {
    const ephemeral: Record<string, unknown>[] = [];
    const typing = snapshot.typing;
    if (
      i.since === null
        ? typing.userIds.length > 0
        : typing.changed > i.since.tSeq
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
    await notificationChanged(app.server, i.userId, i.since.nSeq ?? 0)
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
  if (i.fullState || i.since === null || i.timeoutMs <= 0) return;
  const app = theApp();
  await waitForSync(app, { timeoutMs: i.timeoutMs }, async () => ({
    relevant: await relevantChanged(i, device),
    value: undefined,
  }));
}

export async function syncFor(i: SyncInputs): Promise<Record<string, unknown>> {
  const app = theApp();
  const epoch = (await recoveryState(app.server))?.epoch;
  const recoveryReset = i.since !== null && i.since.epoch !== epoch;
  // Resolve the entire delivery baseline BEFORE old inbox proofs or wait logic.
  // Equal numeric counters from another restore era never reestablish authority.
  if (recoveryReset) i = { ...i, since: null, fullState: true };
  const lp = localpartOf(i.userId);
  const device: DeviceIdentity | null =
    i.deviceId === null || i.deviceGeneration === undefined
      ? null
      : { localpart: lp, deviceId: i.deviceId, generation: i.deviceGeneration };
  const issuedSince = i.since;
  if (i.since !== null) {
    const serverHeads = await syncStreamHeads(app.server);
    const tenantHeads = await app.tenant.tx((tx) => tx.streams.heads());
    i = {
      ...i,
      since: boundFutureToken(i.since, {
        eSeq: serverHeads.events,
        pSeq: serverHeads.presence,
        rSeq: serverHeads.receipts,
        dSeq: serverHeads.devices,
        nSeq: serverHeads.notifications,
        aSeq: tenantHeads.accountData,
        mSeq: tenantHeads.inbox,
        kSeq: tenantHeads.keyPools,
      }),
    };
  }
  if (device !== null) {
    // A repaired numeric baseline is not the exact receipt issued to a client.
    // Never hash it into deletion authority, even if it equals an older receipt.
    await app.tenant.tx((tx) =>
      tx.toDevice.acknowledge(
        device,
        i.since === issuedSince ? issuedSince : null,
      )
    );
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
    const receipts = await receiptSnapshot(tx, i.userId, i.since?.rSeq ?? 0);
    const members = new Map<string, Row[]>();
    for (
      const row of await tx.query(
        `SELECT m.room,m.user,m.membership,m.seq FROM memberships m
      WHERE m.membership IN ('join','invite') AND EXISTS (
        SELECT 1 FROM memberships mine WHERE mine.user=? AND mine.room=m.room
      ) ORDER BY m.room,CASE m.membership WHEN 'join' THEN 0 ELSE 1 END,m.user`,
        [i.userId],
      )
    ) {
      const room = String(row.room);
      if (!members.has(room)) members.set(room, []);
      members.get(room)!.push(row);
    }
    for (const membership of memberships) {
      rooms.set(membership.roomId, {
        receipts: receipts.get(membership.roomId) ?? [],
        members: members.get(membership.roomId) ?? [],
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
  const accountSnapshot = await app.tenant.tx((tx) =>
    captureAccountData(tx, lp, app.tenant.serverName, i.since?.aSeq ?? null)
  );
  const typingSnapshot = captureTyping(
    snapshot.memberships.map((m) => m.roomId),
  );
  const now: StreamToken = {
    eSeq: snapshot.counters.get('events') ?? 0,
    pSeq: snapshot.counters.get('presence') ?? 0,
    tSeq: typingSnapshot.seq,
    rSeq: snapshot.counters.get('receipts') ?? 0,
    aSeq: accountSnapshot.seq,
    dSeq: snapshot.counters.get('devices') ?? 0,
    mSeq: 0,
    kSeq: 0,
    nSeq: snapshot.counters.get('notifications') ?? 0,
    ...(epoch === undefined ? {} : { epoch }),
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
  const roomAccountData = accountSnapshot.rooms;
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
        const pdu = await prejoinDeparture(inviteOf(row), {
          server: app.server,
          signer: app.tenant.signer(),
        });
        if (pdu === null) continue;
        const departure = renderPrejoinDeparture(
          pdu,
          i.userId,
          i.filter.eventFormat,
        );
        leave[roomId] = {
          timeline: { events: [], limited: false, prev_batch: '' },
          [i.useStateAfter ? (i.stateAfterKey ?? 'state_after') : 'state']: {
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
        (typingSnapshot.rooms.get(m.roomId)?.changed ?? 0) <= i.since.tSeq
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
        typing: typingSnapshot.rooms.get(m.roomId) ??
          { userIds: [], changed: 0 },
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
  const deviceLists = recoveryReset
    ? await deviceListSnapshot(app.server, i.userId, 'sync', now.dSeq)
    : i.since === null
    ? { changed: [], left: [] }
    : await deviceListsBetween(
      app.server,
      i.userId,
      i.since.dSeq,
      now.dSeq,
      'sync',
    );
  const accountData = accountSnapshot.global;
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
