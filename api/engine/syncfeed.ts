// api/engine/syncfeed.ts — M4: the per-user /sync (plan §3e). Sync tokens
// are s<eventSeq>_p<presenceSeq> (E3; legacy s<n> parses as _p0) — global
// stream positions, valid across users and as /messages?from=/to= and
// /members?at=. Sections by membership at `now`: join/invite/leave; the
// window semantics (limited, prev_batch) follow Synapse — prev_batch is
// s<firstReturned-1> only when the timeline was trimmed to
// timeline.limit, else s<windowEnd> (synapse/handlers/sync.py:819-821,
// 925-933; M4 blocker B1, ruled 2026-09-16).
import { serverDb, withDb } from './db.ts';
import { serverName } from './config.ts';
import { localpartOf } from './auth.ts';
import {
  eventIndexRow,
  formatStreamToken,
  lookupRoom,
  roomsFor,
  stateAt,
  stateAtSeq,
  type StateRow,
} from './room.ts';
import { clientEventForRow, pduById } from './timeline.ts';
import { canSeeEvent } from './visibility.ts';
import { getPresence, presenceFor, setPresence } from './presence.ts';
import type { RoomFilter } from './filters.ts';
import {
  getAccountData,
  listGlobalAccountData,
  listRoomAccountData,
} from './tenant.ts';
import {
  lastTypingChange,
  sweepTyping,
  typingIn,
  typingSeq,
} from './typing.ts';
import { receiptSeq, receiptSeqForUser, receiptsSince } from './receipts.ts';
import { type EventIndexRow, eventIndexRowOf } from './event-format.ts';
import type { Pdu } from './pdu.ts';

export interface SyncInputs {
  userId: string;
  deviceId: string | null;
  since: { eSeq: number; pSeq: number; tSeq: number; rSeq: number } | null;
  timeoutMs: number;
  filter: RoomFilter;
  fullState: boolean;
  setPresence?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The global stream maxima (next_batch) and the per-user relevant maxima
// (the long-poll wake condition: only rows relevant to this user count).
// Band C (D1): four streams — events, presence, typing (in-memory),
// receipts.
interface StreamMaxes {
  eSeq: number;
  pSeq: number;
  tSeq: number;
  rSeq: number;
}

async function globalMaxes(): Promise<StreamMaxes> {
  return await withDb(serverDb(), async (c) => {
    const e = await c.query('SELECT MAX(seq) AS m FROM event_index;');
    const p = await c.query('SELECT MAX(seq) AS m FROM presence;');
    return {
      eSeq: e.rows[0].m == null ? 0 : Number(e.rows[0].m),
      pSeq: p.rows[0].m == null ? 0 : Number(p.rows[0].m),
      tSeq: typingSeq(),
      rSeq: await receiptSeq(),
    };
  });
}

async function relevantMaxes(userId: string): Promise<StreamMaxes> {
  const base = await withDb(serverDb(), async (c) => {
    const e = await c.query(
      `SELECT MAX(seq) AS m FROM event_index
       WHERE room_id IN (SELECT room_id FROM room_membership WHERE user_id = $1);`,
      [userId],
    );
    const p = await c.query(
      `SELECT MAX(seq) AS m FROM presence
       WHERE user_id IN (
         SELECT DISTINCT rm2.user_id FROM room_membership rm1
         JOIN room_membership rm2 ON rm1.room_id = rm2.room_id
         WHERE rm1.user_id = $1 AND rm1.membership = 'join' AND rm2.membership = 'join'
       );`,
      [userId],
    );
    const joined = await c.query(
      `SELECT room_id FROM room_membership WHERE user_id = $1 AND membership = 'join';`,
      [userId],
    );
    let tMax = 0;
    // deno-lint-ignore no-explicit-any
    for (const row of joined.rows as any[]) {
      tMax = Math.max(tMax, lastTypingChange(String(row.room_id)));
    }
    return {
      eSeq: e.rows[0].m == null ? 0 : Number(e.rows[0].m),
      pSeq: p.rows[0].m == null ? 0 : Number(p.rows[0].m),
      tSeq: tMax,
    };
  });
  return { ...base, rSeq: await receiptSeqForUser(userId) };
}

// Users joined to a room the syncer is joined to (the presence fan-out
// set).
async function sharedJoinedUsers(userId: string): Promise<string[]> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT DISTINCT rm2.user_id AS u FROM room_membership rm1
       JOIN room_membership rm2 ON rm1.room_id = rm2.room_id
       WHERE rm1.user_id = $1 AND rm1.membership = 'join' AND rm2.membership = 'join';`,
      [userId],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map((row) => String(row.u));
  });
}

function typeFilter(f: {
  types?: string[];
  not_types?: string[];
}): (t: string) => boolean {
  return (t: string) => {
    if (f.types !== undefined && !f.types.includes(t)) return false;
    if (f.not_types !== undefined && f.not_types.includes(t)) return false;
    return true;
  };
}

// The viewer's membership at a seq position (E1) — 'leave' when there is
// no member row for them in the state there (MSC4115's default).
async function membershipAtSeq(
  roomId: string,
  userId: string,
  seq: number,
): Promise<string> {
  const rows = (await stateAtSeq(roomId, seq)) ?? [];
  const row = rows.find((r) =>
    r.type === 'm.room.member' && r.stateKey === userId
  );
  return ((row?.content ?? {}) as { membership?: string }).membership ??
    'leave';
}

interface RoomTimelineResult {
  entry: Record<string, unknown>;
  // member events in the raw window (for presence fan-out + device_lists)
  windowJoiners: string[];
  windowLeavers: string[];
}

// One room's join/leave entry: the windowed timeline + the state block.
// `now` carries the stream maxima for prev_batch; `end` is the e-side
// window end (leave rooms read as of their leave).
async function roomTimeline(
  room: { dbName: string; roomVersion: string },
  roomId: string,
  i: SyncInputs,
  now: StreamMaxes,
  sinceESeq: number,
  end: number,
  withSummary: boolean,
): Promise<RoomTimelineResult> {
  // The raw window (sinceESeq, end], oldest first.
  const rawRows: EventIndexRow[] = await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT * FROM event_index
       WHERE room_id = $1 AND rejected = FALSE AND soft_failed = FALSE
         AND seq > $2 AND seq <= $3
       ORDER BY seq ASC;`,
      [roomId, sinceESeq, end],
    );
    // deno-lint-ignore no-explicit-any
    return (r.rows as any[]).map(eventIndexRowOf);
  });

  const windowJoiners: string[] = [];
  const windowLeavers: string[] = [];
  const pdus = new Map<string, Pdu>();
  for (const row of rawRows) {
    const pdu = await pduById(room.dbName, row.commit_hash, row.event_id);
    if (!pdu) continue;
    pdus.set(row.event_id, pdu);
    if (pdu.type === 'm.room.member') {
      const ms = ((pdu.content ?? {}) as { membership?: string }).membership;
      if (ms === 'join') windowJoiners.push(String(pdu.state_key));
      if (ms === 'leave' || ms === 'ban') {
        windowLeavers.push(String(pdu.state_key));
      }
    }
  }

  // Type filter, then cut to the LAST timeline.limit (default 10; 0 →
  // empty). limited = the raw (pre-type-filter) window held more than
  // were returned.
  const filtered = rawRows.filter((r) => {
    const pdu = pdus.get(r.event_id);
    return pdu !== undefined && typeFilter(i.filter.timeline)(pdu.type);
  });
  const limit = i.filter.timeline.limit ?? 10;
  const trimmed = filtered.length > limit;
  const returned = trimmed ? filtered.slice(filtered.length - limit) : filtered;
  const limited = rawRows.length > returned.length;

  // prev_batch (B1 ruling): trimmed → s<firstReturned-1>; untrimmed (or
  // trimmed to empty, e.g. limit 0) → s<windowEnd>. The p/t/r parts ride
  // the global maxima, exactly as pSeq did at M4.
  const prevBatch = trimmed && returned.length > 0
    ? formatStreamToken(returned[0].seq - 1, now.pSeq, now.tSeq, now.rSeq)
    : formatStreamToken(end, now.pSeq, now.tSeq, now.rSeq);

  // Render: visibility per event, unsigned.membership per E1.
  const events: Record<string, unknown>[] = [];
  for (const row of returned) {
    const pdu = pdus.get(row.event_id);
    if (!pdu) continue;
    if (
      !(await canSeeEvent(i.userId, roomId, {
        seq: row.seq,
        type: pdu.type,
        stateKey: pdu.state_key,
      }))
    ) {
      continue;
    }
    const membership = await membershipAtSeq(roomId, i.userId, row.seq);
    const ev = await clientEventForRow(room.dbName, room.roomVersion, row, {
      userId: i.userId,
      deviceId: i.deviceId,
      membership,
    });
    if (ev) events.push(ev);
  }

  // state.events: initial/full_state → state at the timeline start;
  // incremental → the delta between since.eSeq and the timeline start
  // (rows whose event_id differ). An empty timeline's "start" is the
  // window end (a left room's leave point carries its state).
  const timelineStartSeq = returned.length > 0 ? returned[0].seq - 1 : end;
  let stateRows: StateRow[];
  if (i.since === null || i.fullState) {
    stateRows = (await stateAtSeq(roomId, timelineStartSeq)) ?? [];
  } else {
    const atStart = (await stateAtSeq(roomId, timelineStartSeq)) ?? [];
    const atSince = (await stateAtSeq(roomId, i.since.eSeq)) ?? [];
    const sinceMap = new Map(
      atSince.map((r) => [r.type + '' + r.stateKey, r.eventId] as const),
    );
    stateRows = atStart.filter((r) =>
      sinceMap.get(r.type + '' + r.stateKey) !== r.eventId
    );
  }
  stateRows = stateRows.filter((r) => typeFilter(i.filter.state)(r.type));
  if (i.filter.state.lazy_load_members) {
    const senders = new Set(events.map((e) => String(e.sender)));
    stateRows = stateRows.filter((r) =>
      r.type !== 'm.room.member' || senders.has(r.stateKey)
    );
  }
  const stateEvents: Record<string, unknown>[] = [];
  for (const r of stateRows) {
    const idx = await eventIndexRow(roomId, r.eventId);
    if (!idx) continue;
    const ev = await clientEventForRow(room.dbName, room.roomVersion, idx, {
      userId: i.userId,
      deviceId: i.deviceId,
    });
    if (ev) stateEvents.push(ev);
  }

  const entry: Record<string, unknown> = {
    state: { events: stateEvents },
    timeline: { events, limited, prev_batch: prevBatch },
    ephemeral: { events: [] },
    account_data: { events: [] },
    unread_notifications: {},
  };

  if (withSummary) {
    entry.summary = await summaryFor(roomId, i.userId);

    // Ephemeral (band C item 3): m.typing + m.receipt, with NO room_id
    // on either (TestTyping + TestRoomReceipts pin the absence). Typing:
    // initial sync emits only a non-empty set; incremental emits
    // whenever the room's typing moved since the token's _t<n> (a stop
    // therefore surfaces as user_ids: []). Receipts: rows with
    // seq > the token's _r<n> (initial: all) as one m.receipt (§3d).
    const ephemeral: Record<string, unknown>[] = [];
    if (i.since === null) {
      const { userIds } = typingIn(roomId);
      if (userIds.length > 0) {
        ephemeral.push({ type: 'm.typing', content: { user_ids: userIds } });
      }
    } else if (lastTypingChange(roomId) > i.since.tSeq) {
      const { userIds } = typingIn(roomId);
      ephemeral.push({ type: 'm.typing', content: { user_ids: userIds } });
    }
    const receiptContent = await receiptsSince(roomId, i.since?.rSeq ?? 0);
    if (receiptContent !== null) {
      ephemeral.push({ type: 'm.receipt', content: receiptContent });
    }
    entry.ephemeral = { events: ephemeral };

    // Room account_data: all current rows on initial sync and whenever
    // the room appears in a sync — no per-row seq (plan §2; the
    // m.fully_read test is initial-sync only).
    const adRows = await listRoomAccountData(
      serverName(),
      localpartOf(i.userId),
      roomId,
    );
    entry.account_data = {
      events: adRows.map((r) => ({ type: r.type, content: r.content })),
    };
  }
  return { entry, windowJoiners, windowLeavers };
}

// summary on join rooms: the two counts always; m.heroes = up to 5 other
// members' ids (joined then invited) when there are any.
async function summaryFor(
  roomId: string,
  userId: string,
): Promise<Record<string, unknown>> {
  return await withDb(serverDb(), async (c) => {
    const counts = await c.query(
      `SELECT membership, COUNT(*) AS n FROM room_membership
       WHERE room_id = $1 AND membership IN ('join', 'invite') GROUP BY membership;`,
      [roomId],
    );
    let joined = 0;
    let invited = 0;
    // deno-lint-ignore no-explicit-any
    for (const row of counts.rows as any[]) {
      if (String(row.membership) === 'join') joined = Number(row.n);
      if (String(row.membership) === 'invite') invited = Number(row.n);
    }
    const heroes = await c.query(
      `SELECT user_id FROM room_membership
       WHERE room_id = $1 AND user_id <> $2 AND membership IN ('join', 'invite')
       ORDER BY CASE membership WHEN 'join' THEN 0 ELSE 1 END, user_id
       LIMIT 5;`,
      [roomId, userId],
    );
    const out: Record<string, unknown> = {
      'm.joined_member_count': joined,
      'm.invited_member_count': invited,
    };
    // deno-lint-ignore no-explicit-any
    const heroIds = (heroes.rows as any[]).map((r) => String(r.user_id));
    if (heroIds.length > 0) out['m.heroes'] = heroIds;
    return out;
  });
}

// invite_state: stripped events (type, state_key, content, sender) from
// the state at the invite's state_commit_hash (E1) — the invitee's
// m.room.member plus the spec's stripped-state list when present
// (sync.yaml "Stripped state" at v1.16).
const STRIPPED_TYPES = new Set([
  'm.room.create',
  'm.room.join_rules',
  'm.room.name',
  'm.room.topic',
  'm.room.avatar',
  'm.room.canonical_alias',
  'm.room.encryption',
]);

async function inviteState(
  dbName: string,
  roomId: string,
  userId: string,
  inviteEventId: string,
): Promise<Record<string, unknown>[]> {
  const inviteIdx = await eventIndexRow(roomId, inviteEventId);
  if (!inviteIdx || inviteIdx.state_commit_hash === null) return [];
  const rows = await stateAt(dbName, inviteIdx.state_commit_hash);
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const isInviteeMember = r.type === 'm.room.member' && r.stateKey === userId;
    if (!isInviteeMember && !STRIPPED_TYPES.has(r.type)) continue;
    const idx = await eventIndexRow(roomId, r.eventId);
    if (!idx) continue;
    const pdu = await pduById(dbName, idx.commit_hash, r.eventId);
    if (!pdu) continue;
    out.push({
      type: r.type,
      state_key: r.stateKey,
      content: r.content,
      sender: pdu.sender,
    });
  }
  return out;
}

function presenceEvent(
  userId: string,
  row: { presence: string; statusMsg: string | null; lastActiveMs: number },
): Record<string, unknown> {
  const content: Record<string, unknown> = { presence: row.presence };
  if (row.statusMsg !== null) content.status_msg = row.statusMsg;
  if (row.presence !== 'offline' && row.lastActiveMs > 0) {
    content.last_active_ago = Math.max(0, Date.now() - row.lastActiveMs);
  }
  return { type: 'm.presence', sender: userId, content };
}

export async function syncFor(i: SyncInputs): Promise<Record<string, unknown>> {
  // 1. set_presence first (so the response and others see it)
  if (i.setPresence !== undefined) {
    await setPresence(i.userId, i.setPresence);
  }

  // 1b. the typing sweep is the sync's read point (typing.ts) — up front,
  //     so next_batch's _t<n> covers expiries reflected in this response
  sweepTyping();

  // 2. long-poll: wait until a RELEVANT row passes the since position
  //    (events in the syncer's rooms; presence of room-sharers; typing
  //    or receipts in joined rooms), or the deadline. Cap 30 s; poll
  //    500 ms.
  if (i.since !== null) {
    const deadline = Date.now() + Math.min(i.timeoutMs, 30000);
    while (true) {
      const rel = await relevantMaxes(i.userId);
      if (
        rel.eSeq > i.since.eSeq || rel.pSeq > i.since.pSeq ||
        rel.tSeq > i.since.tSeq || rel.rSeq > i.since.rSeq
      ) break;
      if (Date.now() >= deadline) break;
      await sleep(500);
    }
  }

  // 3. now + next_batch
  const now = await globalMaxes();
  const nextBatch = formatStreamToken(now.eSeq, now.pSeq, now.tSeq, now.rSeq);

  // 4. room set + sections (by membership at now)
  const memberships = await roomsFor(i.userId);
  const join: Record<string, unknown> = {};
  const invite: Record<string, unknown> = {};
  const leave: Record<string, unknown> = {};
  const allJoiners = new Set<string>();
  const allLeavers = new Set<string>();

  // Band C (3i): invites from ignored users never reach the client
  // (ignore_users.md:45-46 — "Servers must not send room invites from
  // ignored users to clients"). Loaded once per sync.
  const ignoredRaw = await getAccountData(
    serverName(),
    localpartOf(i.userId),
    '',
    'm.ignored_user_list',
  );
  const ignoredUsers = new Set(
    Object.keys(
      ((ignoredRaw as { ignored_users?: Record<string, unknown> } | null)
        ?.ignored_users ?? {}) as Record<string, unknown>,
    ),
  );

  for (const m of memberships) {
    const room = await lookupRoom(m.roomId);
    if (!room) continue;
    if (m.membership === 'invite') {
      if (ignoredUsers.size > 0) {
        const idx = await eventIndexRow(m.roomId, m.eventId);
        const inviter = idx
          ? (await pduById(room.dbName, idx.commit_hash, m.eventId))?.sender
          : undefined;
        if (inviter !== undefined && ignoredUsers.has(inviter)) continue;
      }
      invite[m.roomId] = {
        invite_state: {
          events: await inviteState(room.dbName, m.roomId, i.userId, m.eventId),
        },
      };
      continue;
    }
    if (m.membership === 'leave' || m.membership === 'ban') {
      // D4: forgotten rooms vanish from initial and full_state syncs
      // entirely — but an in-window leave event still comes down an
      // incremental sync (the forget test's "Leave for forgotten room
      // shows up in v2 incremental /sync"; Synapse does the same).
      if (m.forgotten && (i.since === null || i.fullState)) continue;
      // Leave-room selection (synapse/handlers/sync.py, transcribed at
      // execution): initial syncs gate archived rooms on include_leave;
      // incremental (and full_state) syncs include a leave room whenever
      // the leave event is in the window ("Always include leave/ban
      // events", no include_leave needed).
      const include = i.since === null
        ? i.filter.includeLeave
        : m.seq > i.since.eSeq;
      if (!include) continue;
      const { entry, windowJoiners, windowLeavers } = await roomTimeline(
        room,
        m.roomId,
        i,
        now,
        i.since?.eSeq ?? 0,
        m.seq, // left users read as of their leave
        false,
      );
      leave[m.roomId] = entry;
      for (const u of windowJoiners) allJoiners.add(u);
      for (const u of windowLeavers) allLeavers.add(u);
      continue;
    }
    // join
    if (i.since !== null && !i.fullState) {
      // Unchanged rooms are omitted in incremental syncs — where
      // "changed" covers the ephemeral streams too (band C item 3):
      // a typing change or a new receipt surfaces the room with an
      // otherwise empty timeline.
      const has = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          `SELECT 1 FROM event_index
           WHERE room_id = $1 AND rejected = FALSE AND soft_failed = FALSE
             AND seq > $2 AND seq <= $3 LIMIT 1;`,
          [m.roomId, i.since!.eSeq, now.eSeq],
        );
        if (r.rows.length > 0) return true;
        const rr = await c.query(
          'SELECT 1 FROM receipts WHERE room_id = $1 AND seq > $2 LIMIT 1;',
          [m.roomId, i.since!.rSeq],
        );
        return rr.rows.length > 0;
      });
      const typingMoved = lastTypingChange(m.roomId) > i.since.tSeq;
      if (!has && !typingMoved) continue; // unchanged room omitted
    }
    const { entry, windowJoiners, windowLeavers } = await roomTimeline(
      room,
      m.roomId,
      i,
      now,
      i.since?.eSeq ?? 0,
      now.eSeq,
      true,
    );
    join[m.roomId] = entry;
    for (const u of windowJoiners) allJoiners.add(u);
    for (const u of windowLeavers) allLeavers.add(u);
  }

  // 9. presence.events
  const presenceEvents = new Map<string, Record<string, unknown>>();
  const shared = await sharedJoinedUsers(i.userId);
  if (i.since === null) {
    for (const u of shared) {
      presenceEvents.set(u, presenceEvent(u, await getPresence(u)));
    }
  } else {
    for (const row of await presenceFor(shared, i.since.pSeq)) {
      presenceEvents.set(row.userId, presenceEvent(row.userId, row));
    }
    // join fan-out: every m.room.member join in the window — the joiner's
    // presence to the syncer; when the syncer IS the joiner, every
    // member's presence.
    for (const u of allJoiners) {
      presenceEvents.set(u, presenceEvent(u, await getPresence(u)));
      if (u === i.userId) {
        for (const other of shared) {
          presenceEvents.set(
            other,
            presenceEvent(other, await getPresence(other)),
          );
        }
      }
    }
  }

  // 10. device_lists (incremental only): changed = users whose join
  //     landed in the window; left = users whose leave/ban landed in the
  //     window and who now share no joined room with the syncer.
  const deviceChanged: string[] = [];
  const deviceLeft: string[] = [];
  if (i.since !== null) {
    for (const u of allJoiners) deviceChanged.push(u);
    for (const u of allLeavers) {
      const sharedRooms = await withDb(serverDb(), async (c) => {
        const r = await c.query(
          `SELECT 1 FROM room_membership a
           JOIN room_membership b ON a.room_id = b.room_id
           WHERE a.user_id = $1 AND a.membership = 'join'
             AND b.user_id = $2 AND b.membership = 'join' LIMIT 1;`,
          [i.userId, u],
        );
        return r.rows.length > 0;
      });
      if (!sharedRooms) deviceLeft.push(u);
    }
  }

  // 11. account_data: global rows on initial sync only (M2 behaviour)
  const accountData: Record<string, unknown>[] = [];
  if (i.since === null) {
    for (
      const row of await listGlobalAccountData(
        serverName(),
        localpartOf(i.userId),
      )
    ) {
      accountData.push({ type: row.type, content: row.content });
    }
  }

  // 12. empty sections are emitted as {} / []
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
