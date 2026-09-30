// api/engine/membership.ts — M4 membership operations (plan §3d). Each op
// authors an m.room.member with the right sender/state_key/content and
// ingests it; the rulebook decides authorization (M3). Rulebook rejects
// map to MatrixError(403, 'M_FORBIDDEN'); authorAndIngest holds the room
// lock across author+ingest (E5), so concurrent ops never stale-prev.
import { serverName } from './config.ts';
import { localpartOf } from './auth.ts';
import {
  author,
  authorAndIngest,
  ingestJoinSnapshotLocked,
  withRoomLock,
} from './ingest.ts';
import { MatrixError } from './matrix-error.ts';
import { ident, serverDb, withDb } from './db.ts';
import {
  chapterHead,
  extremities,
  lookupRoom,
  membershipOf,
  roomsFor,
  serversInRoom,
  stateAt,
  stateAtSeq,
} from './room.ts';
import { getProfile } from './tenant.ts';
import { authChain } from './rulebook/state-res-v2.ts';
import { joinRemoteRoom } from './federation/joins.ts';
import {
  inviteFor,
  inviteRemote,
  markInviteJoined,
  rejectInviteRemote,
} from './federation/invites.ts';
import { domainOf } from './federation/pdu.ts';
import type { Pdu } from './pdu.ts';
import type { StateRowInput } from './materialize.ts';

export interface MembershipOpResult {
  roomId: string;
  eventId: string;
  // false when an idempotent op returned the existing event (re-join).
  created: boolean;
}

// M5b (r6, astra): purgeable_ms is cleared by any join or invite
// acceptance — an active room is never on the offered (purgatory) list.
export async function clearPurgeable(roomId: string): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE room_directory SET purgeable_ms = NULL WHERE room_id = $1;',
      [roomId],
    );
  });
}

// Author + ingest the member event (prev_events = the live extremities,
// recomputed per attempt); a rulebook reject surfaces as 403 M_FORBIDDEN,
// never a 500.
async function authorMember(
  roomId: string,
  sender: string,
  stateKey: string,
  content: Record<string, unknown>,
  prevs?: string[],
): Promise<MembershipOpResult> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  try {
    const res = await authorAndIngest(roomId, {
      type: 'm.room.member',
      state_key: stateKey,
      sender,
      content,
      ...(prevs !== undefined ? { prev_events: prevs } : {}),
      origin_server_ts: Date.now(),
    });
    // M5b (r6, astra): an active room never carries a deletion marker
    if (content.membership === 'join' || content.membership === 'invite') {
      await clearPurgeable(roomId);
    }
    return { roomId, eventId: res.event_id, created: true };
  } catch (e) {
    const msg = String(e);
    if (
      msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT') ||
      msg.includes('M_NO_CREATE') || msg.includes('E_ROOM_ARCHIVED')
    ) {
      // never a 500 on a client path (fix pass §3.4)
      throw new MatrixError(403, 'M_FORBIDDEN', msg);
    }
    throw e;
  }
}

// join: sender == state_key == the user; content from the profile
// (displayname/avatar_url) with the request body keys merged on top.
// Already joined -> the existing event, no new one (idempotent re-join).
// M5b (§3.6/§3.6b): a room we never held joins over federation
// (joinRemoteRoom); an ARCHIVED room asks its server list — others →
// the remote dance; only ourselves / nobody → the local reopen
// (joinArchived, commit 1's).
export async function join(
  roomId: string,
  userId: string,
  extraContent?: Record<string, unknown>,
  opts: { via?: string[]; serverName?: string[] } = {},
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, userId);
  if (current?.membership === 'join') {
    return { roomId, eventId: current.eventId, created: false };
  }
  const room = await lookupRoom(roomId);
  if (room !== null && room.currentChapter !== null) {
    // a live room — the plain local join
    const profile = await getProfile(serverName(), localpartOf(userId));
    const content: Record<string, unknown> = {
      ...(profile?.displayname !== undefined
        ? { displayname: profile.displayname }
        : {}),
      ...(profile?.avatar_url !== undefined
        ? { avatar_url: profile.avatar_url }
        : {}),
      ...(extraContent ?? {}),
      membership: 'join',
    };
    return await authorMember(roomId, userId, userId, content);
  }
  // archived or unknown: the server list decides whom to ask (§3.6b) —
  // via/server_name first, then the held room's servers from the last
  // known state, and the inviter's server when we hold a pending invite
  // (§3.8, wired in commit 9)
  const via = opts.via ?? opts.serverName ?? [];
  const held = room !== null ? await serversInRoom(roomId) : [];
  const invite = await inviteFor(roomId, userId);
  const inviter = invite !== null && invite.status === 'pending'
    ? [invite.origin]
    : [];
  const others = [...new Set([...via, ...inviter, ...held])].filter((d) =>
    d !== serverName()
  );
  if (others.length === 0) {
    // only ourselves / nobody → the local reopen (a room we never held
    // has nobody to ask and no snapshot either)
    if (room === null) {
      throw new MatrixError(
        404,
        'M_NOT_FOUND',
        'no servers to join through',
      );
    }
    const reopened = await joinArchived(roomId, userId, extraContent);
    await markInviteJoined(roomId, userId);
    return reopened;
  }
  // others → the remote dance
  const res = await joinRemoteRoom(roomId, userId, others, extraContent);
  await markInviteJoined(roomId, userId);
  return { roomId: res.roomId, eventId: res.eventId, created: true };
}

// §3.6b "ask nobody / only ourselves": the local reopen. The snapshot is
// the previous stay's tip state (chapterHead), its auth_chain ours to
// compute, and the join's prev_events are that stay's extremities (its
// x* tips — grounded, positioned events). From here §3.6 steps 7–9 run
// unchanged: a new chapter pair, the root commit from the snapshot, our
// signed join on top, new current_chapter. The new history chapter is
// complete at birth (its would-be first event is already held in the
// previous stay), so nothing is ever fetched into it.
async function joinArchived(
  roomId: string,
  userId: string,
  extraContent?: Record<string, unknown>,
): Promise<MembershipOpResult> {
  const room = await lookupRoom(roomId);
  if (!room) throw new Error('M_ROOM_NOT_FOUND: ' + roomId);
  return await withRoomLock(roomId, async () => {
    const oldHead = await chapterHead(roomId);
    if (oldHead === null) {
      throw new Error('E_NO_STAY: archived room has no stay branch');
    }
    const oldTip = await withDb(room.dbName, async (c) => {
      const r = await c.query(`SELECT HASHOF('${ident(oldHead)}') AS h;`);
      return String(r.rows[0].h);
    });
    // the snapshot = the state at the previous stay's tip; the root
    // commit carries the snapshot events + their auth chain (ancestry
    // loading from the new branch must find them — r4, astra). The
    // events live on their own x* commits (a chapter tip holds only the
    // materialized state), so the load goes through event_index's
    // commit hashes — each x* lineage carries its full ancestry.
    const stateRows = (await stateAt(room.dbName, oldTip)) ?? [];
    const { rootEvents, rootStateRows } = await (async () => {
      const hashes: string[] = [];
      for (const sr of stateRows) {
        const ch = await withDb(serverDb(), async (s) => {
          const r = await s.query(
            'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
            [roomId, sr.eventId],
          );
          return r.rows.length ? String(r.rows[0].commit_hash) : null;
        });
        if (ch === null) {
          throw new Error('E_STATE_EVENT_MISSING: ' + sr.eventId);
        }
        hashes.push(ch);
      }
      const pduById = new Map<string, Pdu>();
      const rejectedIds = new Set<string>();
      await withDb(room.dbName, async (c) => {
        for (const h of new Set(hashes)) {
          const r = await c.query(
            `SELECT event_id, canonical_json, rejected FROM events AS OF '${h}';`,
          );
          // deno-lint-ignore no-explicit-any
          for (const row of r.rows as any[]) {
            const id = String(row.event_id);
            if (!pduById.has(id)) {
              pduById.set(
                id,
                typeof row.canonical_json === 'string'
                  ? JSON.parse(row.canonical_json)
                  : row.canonical_json,
              );
            }
            if (row.rejected === true) rejectedIds.add(id);
          }
        }
      });
      const store = {
        get: (id: string) => pduById.get(id),
        isRejected: (id: string) => rejectedIds.has(id),
      };
      const ids = stateRows.map((sr) => sr.eventId);
      const chain = authChain(ids, store);
      const rootEvents: { pdu: Pdu; eventId: string }[] = [];
      for (const id of new Set([...ids, ...chain])) {
        const pdu = pduById.get(id);
        if (!pdu) throw new Error('E_STATE_EVENT_MISSING: ' + id);
        rootEvents.push({ pdu, eventId: id });
      }
      const rootStateRows: StateRowInput[] = stateRows.map((sr) => ({
        type: sr.type,
        stateKey: sr.stateKey,
        eventId: sr.eventId,
        content: sr.content,
      }));
      return { rootEvents, rootStateRows };
    })();
    // the join, authored on the old stay's extremities (its x* tips —
    // grounded, positioned events)
    const oldX = await extremities(room.dbName, roomId, oldHead);
    const profile = await getProfile(serverName(), localpartOf(userId));
    const content: Record<string, unknown> = {
      ...(profile?.displayname !== undefined
        ? { displayname: profile.displayname }
        : {}),
      ...(profile?.avatar_url !== undefined
        ? { avatar_url: profile.avatar_url }
        : {}),
      ...(extraContent ?? {}),
      membership: 'join',
    };
    const joinPdu = await author(roomId, {
      type: 'm.room.member',
      state_key: userId,
      sender: userId,
      content,
      prev_events: oldX.map((e) => e.eventId),
      origin_server_ts: Date.now(),
    });
    // allocate the chapter pair (n = highest existing + 1 — always even)
    const { hist, stay } = await withDb(room.dbName, async (c) => {
      const r = await c.query('SELECT name FROM dolt.branches;');
      let best = -1;
      // deno-lint-ignore no-explicit-any
      for (const row of r.rows as any[]) {
        const m = /^chapter(\d+)$/.exec(String(row.name));
        if (m && Number(m[1]) > best) best = Number(m[1]);
      }
      const n = best + 1;
      const hist = `chapter${n}`;
      const stay = `chapter${n + 1}`;
      await c.query(
        `SELECT DOLT_BRANCH('${ident(hist)}', '${room.genesisCommit}');`,
      );
      await c.query(
        `SELECT DOLT_BRANCH('${ident(stay)}', '${room.genesisCommit}');`,
      );
      return { hist, stay };
    });
    void hist; // the history chapter is complete at birth (§3.6b)
    const res = await ingestJoinSnapshotLocked(roomId, {
      chapter: stay,
      rootEvents,
      rootStateRows,
      join: joinPdu,
      rootMessage: `snapshot before ${String(joinPdu.event_id)} (local reopen)`,
      origin: null,
      newEvidence: false,
    });
    await clearPurgeable(roomId);
    return { roomId, eventId: res.event_id, created: true };
  });
}

// leave: self only (sender == state_key). Never a member -> 403. M5b
// (§3.8 step 6): on a federation_invites room (an out-of-band invite we
// have not accepted) this is the REJECT — local effect at once + the
// retried intent (ruling F; no silent local-only fallback).
export async function leave(
  roomId: string,
  userId: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, userId);
  if (current === null || current.membership === 'invite') {
    // an out-of-band invite (a room we do not hold) → the REJECT (§3.8
    // step 6, ruling F)
    const invite = await inviteFor(roomId, userId);
    if (invite !== null && invite.status !== 'joined') {
      await rejectInviteRemote(roomId, userId);
      return { roomId, eventId: invite.eventId, created: false };
    }
    if (current === null) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'never a member of ' + roomId);
    }
  }
  const content: Record<string, unknown> = { membership: 'leave' };
  if (reason !== undefined) content.reason = reason;
  // an invited user's reject lands even when the stay is closed (the
  // last joined local member left): parent it on the newest stay's
  // tips — the ingest carve-out lets it into the closed stay without
  // reopening it (fix pass §3.4)
  let prevs: string[] | undefined;
  if (current?.membership === 'invite') {
    const room = await lookupRoom(roomId);
    const head = room === null ? null : await chapterHead(roomId);
    if (room !== null && head !== null) {
      prevs = (await extremities(room.dbName, roomId, head)).map((e) =>
        e.eventId
      );
    }
  }
  return await authorMember(roomId, userId, userId, content, prevs);
}

const USER_ID_RE = /^@[^:\s]+:[^\s]+$/;

// invite: sender invites the target. Self-invite -> 403; target already
// joined -> 403; malformed target -> 400 M_INVALID_PARAM. M5b (§3.8): a
// REMOTE target goes over federation (admit → author → /v2/invite →
// merge → ingest as our own); a local target authors into the room.
export async function invite(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  if (!USER_ID_RE.test(target)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'not a user id: ' + target);
  }
  if (target === sender) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'cannot invite yourself');
  }
  const current = await membershipOf(roomId, target);
  if (current?.membership === 'join') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      target + ' is already in the room',
    );
  }
  if (domainOf(target) !== serverName()) {
    const res = await inviteRemote(roomId, sender, target, reason);
    return { roomId, eventId: res.eventId, created: true };
  }
  const content: Record<string, unknown> = { membership: 'invite' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}

// ban: sender bans the target (any current membership; the rulebook
// decides — a non-present or under-powered sender gets a 403).
export async function ban(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const content: Record<string, unknown> = { membership: 'ban' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}

// unban: the spec's leave-from-ban (banning.yaml:90-135) — a member-leave
// for the target, authored by the sender (kick power, rulebook decides).
// The target must be banned (400 M_BAD_STATE otherwise, Synapse's shape).
export async function unban(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, target);
  if (current?.membership !== 'ban') {
    throw new MatrixError(
      400,
      'M_BAD_STATE',
      `${target} is not banned from ${roomId}`,
    );
  }
  const content: Record<string, unknown> = { membership: 'leave' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}

// Profile change → member events (band C D5; spec v1.16 client-server-api
// _index.md:3773-3795 "Events on Change of Profile Information": an
// m.room.member join event goes to every room the user is joined to).
// Called from the two profile PUT endpoints after the tenant row updated.
// Content = the user's CURRENT member content with the one field replaced
// (null/absent removes the key); avatar_url goes verbatim (the Complement
// test sends a non-mxc string). join→join by self is rulebook-allowed
// (rule 4.3), so the fan-out is plain authorMember per joined room.
export async function propagateProfile(
  userId: string,
  field: 'displayname' | 'avatar_url',
): Promise<void> {
  const profile = await getProfile(serverName(), localpartOf(userId));
  const value = field === 'displayname'
    ? profile?.displayname
    : profile?.avatar_url;
  for (const m of await roomsFor(userId)) {
    if (m.membership !== 'join') continue;
    const state = (await stateAtSeq(m.roomId, null)) ?? [];
    const row = state.find(
      (r) => r.type === 'm.room.member' && r.stateKey === userId,
    );
    const content = {
      ...((row?.content ?? {}) as Record<string, unknown>),
    };
    delete content.membership;
    if (value === undefined || value === null) delete content[field];
    else content[field] = value;
    await authorMember(m.roomId, userId, userId, {
      ...content,
      membership: 'join',
    });
  }
}

// forget (band C D4, spec v1.16 leaving.yaml:80-126): set the forgotten
// flag on the membership row. Still joined → 400 M_UNKNOWN (the spec's
// literal errcode and message shape); leave/ban (incl. the
// invited-then-left row) → forgotten; no row at all → 400 M_UNKNOWN.
// A live invite row is forgotten too: leaving.yaml:91-92 blocks only
// joined users ("they must leave the room before calling this API") —
// the plan enumerates the tested rows; invite is spec-decided here.
// Any later membership event clears the flag (ingest E2).
export async function forget(roomId: string, userId: string): Promise<void> {
  const current = await membershipOf(roomId, userId);
  if (current?.membership === 'join') {
    throw new MatrixError(
      400,
      'M_UNKNOWN',
      `User ${userId} is in room ${roomId}`,
    );
  }
  if (current === null) {
    throw new MatrixError(400, 'M_UNKNOWN', 'no membership to forget');
  }
  await withDb(serverDb(), async (c) => {
    await c.query(
      'UPDATE room_membership SET forgotten = TRUE WHERE room_id = $1 AND user_id = $2;',
      [roomId, userId],
    );
  });
  // M5b (§3.6a "Drop", ruling §9-10): when EVERY local user has
  // forgotten the room, mark it purgeable — the operator's `rooms --
  // purge` drops it (never a built-in timer, never on leave alone).
  await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT count(*) AS n FROM room_membership
       WHERE room_id = $1 AND forgotten = FALSE AND user_id LIKE '%:' || $2;`,
      [roomId, serverName()],
    );
    if (Number(r.rows[0].n) === 0) {
      await c.query(
        'UPDATE room_directory SET purgeable_ms = $2 WHERE room_id = $1 AND purgeable_ms IS NULL;',
        [roomId, Date.now()],
      );
    }
  });
}

// kick: a leave authored by someone else. The target must be in the room
// (join/invite/knock) — the spec's auth rules (4.5.4) carry no
// target-membership condition, so this 403 is an op-layer check, as in
// Synapse's REST handler (room_member.py:1027,1044: "The target user is
// not in the room").
export async function kick(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(roomId, target);
  if (
    current === null ||
    !['join', 'invite', 'knock'].includes(current.membership)
  ) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'The target user is not in the room',
    );
  }
  const content: Record<string, unknown> = { membership: 'leave' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(roomId, sender, target, content);
}
