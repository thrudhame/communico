// api/engine/room/membership.ts — membership op gates over the local
// ingest (the old membership.ts's local paths): each op authors an
// m.room.member with the right sender/state_key/content and ingests it;
// the rulebook decides authorization and a reject maps to 403
// M_FORBIDDEN, never a 500. Profile fan-out, forget/purgeable and the
// federation dances are 3c/4.
import { MatrixError } from '#engine/matrix-error.ts';
import { validEventUserId } from '#engine/ids.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Room, RoomTx } from '#engine/room/index.ts';
import { afterLocalCommit, sendLocal } from '#engine/room/ingest.ts';
import { prepareSigner, type Signer } from '#engine/room/signer.ts';
import { buildInTx } from '#engine/room/build.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import {
  admitLocalJoin,
  type LocalJoinObservation,
  type MembershipAdmission,
  prepareJoinObservation,
  prepareMembershipAdmission,
  withMembershipFence,
} from '#engine/room/hooks.ts';
import { withRestrictedAdmission } from './restricted.ts';

export type MembershipOpResult = {
  roomId: string;
  eventId: string;
  // false when an idempotent op returned the existing event (re-join).
  created: boolean;
};

// The "now" membership of a user: the open stay's current state, else the
// latest closed stay's (requirements §1.1 row 4).
export async function membershipOf(
  room: Room,
  userId: string,
): Promise<{ membership: string; eventId: string } | null> {
  return await room.tx((tx) => membershipInTx(tx, userId));
}

async function membershipInTx(
  tx: RoomTx,
  userId: string,
): Promise<{ membership: string; eventId: string } | null> {
  let stay = await tx.segments.openStay();
  if (stay === null) {
    const stays = (await tx.segments.list()).filter((s) => s.kind === 'stay');
    stay = stays.length === 0 ? null : stays[stays.length - 1];
  }
  if (stay === null) return null;
  const group = await tx.state.current(stay.id);
  if (group === null) return null;
  const id = await tx.state.groupKey(group, 'm.room.member', userId);
  if (id === null) return null;
  const row = await tx.events.get(id);
  if (row === null) return null;
  const membership = (JSON.parse(row.pdu) as Pdu).content?.membership;
  return typeof membership === 'string' ? { membership, eventId: id } : null;
}

// Author + ingest the member event; a rulebook reject surfaces as 403
// M_FORBIDDEN, never a 500.
async function authorMember(
  room: Room,
  sender: string,
  stateKey: string,
  content: Record<string, unknown>,
  signer: Signer,
): Promise<MembershipOpResult> {
  const res = await sendLocal(room, {
    type: 'm.room.member',
    sender,
    state_key: stateKey,
    content,
    origin_server_ts: Date.now(),
  }, signer).catch((e) => {
    if (
      String(e).includes('E_ROOM_ARCHIVED') || String(e).includes('M_NO_CREATE')
    ) throw new MatrixError(403, 'M_FORBIDDEN', String(e));
    throw e;
  });
  if (res.standing === 'rejected') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `membership rejected (${res.reason}${
        res.rule === null ? '' : ', rule ' + res.rule
      })`,
    );
  }
  return { roomId: room.id, eventId: res.eventId, created: true };
}

// join: sender == state_key == the user. Already joined -> the existing
// event, no new one (idempotent re-join).
export async function join(
  room: Room,
  userId: string,
  signer: Signer,
  extraContent?: Record<string, unknown>,
): Promise<MembershipOpResult> {
  return (await admitJoin(room, userId, signer, extraContent))!;
}

// A nonresident result is a locked routing decision, not a public 404 caused
// by racing the last local departure. The caller can discover remote peers.
export async function joinResident(
  room: Room,
  userId: string,
  signer: Signer,
  extraContent?: Record<string, unknown>,
): Promise<MembershipOpResult | null> {
  return await admitJoin(room, userId, signer, extraContent, () => null, false);
}

async function admitJoin(
  room: Room,
  userId: string,
  signer: Signer,
  extraContent?: Record<string, unknown>,
  absent?: (
    tx: RoomTx,
    signer: Signer,
  ) => Promise<MembershipOpResult | null> | null,
  prepareAbsent = true,
): Promise<MembershipOpResult | null> {
  let prepared = signer;
  let admission: MembershipAdmission | undefined;
  let observation: LocalJoinObservation | undefined;
  const result = await withRestrictedAdmission(
    room,
    userId,
    signer.serverName,
    (tx, authorizer) =>
      withMembershipFence(admission, async () => {
        const current = await membershipInTx(tx, userId);
        if (current?.membership === 'join') {
          return { roomId: room.id, eventId: current.eventId, created: false };
        }
        const content = { ...extraContent, membership: 'join' } as Record<
          string,
          unknown
        >;
        delete content.join_authorised_via_users_server;
        if (authorizer !== null) {
          content.join_authorised_via_users_server = authorizer;
        }
        const pdu = await buildInTx(tx, room.id, {
          type: 'm.room.member',
          sender: userId,
          state_key: userId,
          content,
        }, prepared);
        const res = await ingestInTx(tx, room.id, pdu, {
          self: signer.serverName,
        });
        if (res.standing !== 'accepted') {
          throw new MatrixError(
            403,
            'M_FORBIDDEN',
            `membership rejected (${res.rule})`,
          );
        }
        await tx.joinObservations.complete(res.eventId, observation);
        return { roomId: room.id, eventId: res.eventId, created: true };
      }),
    undefined,
    async (resident) => {
      await admitLocalJoin(room.store, room.id, userId);
      observation = await prepareJoinObservation(room.store, room.id, userId);
      admission = await prepareMembershipAdmission(
        room.store,
        room.id,
        userId,
        true,
      );
      // This runs under the authoring lock, but outside the room transaction.
      // A retained result needs projection repair, not fresh signing authority.
      if (!resident && !prepareAbsent) return;
      if ((await membershipOf(room, userId))?.membership !== 'join') {
        prepared = await prepareSigner(signer);
      }
    },
    absent
      ? (tx) =>
        withMembershipFence(admission, async () => {
          const result = await absent(tx, prepared);
          if (result?.created) {
            await tx.joinObservations.complete(result.eventId, observation);
          }
          return result;
        })
      : undefined,
  );
  if (result !== null) {
    await afterLocalCommit(room, result.eventId, signer.serverName);
  }
  return result;
}

export async function knock(
  room: Room,
  userId: string,
  signer: Signer,
  extraContent?: Record<string, unknown>,
) {
  return await authorMember(room, userId, userId, {
    ...extraContent,
    membership: 'knock',
  }, signer);
}

// leave: self only (sender == state_key). Its check and mutation share the room
// lock/transaction, so durable cleanup and client retries cannot author twice.
export async function leave(
  room: Room,
  userId: string,
  signer: Signer,
  reason?: string,
): Promise<MembershipOpResult> {
  const outcome = await withRoomLock(room.id, async () => {
    const admission = await prepareMembershipAdmission(
      room.store,
      room.id,
      userId,
    );
    const current = await membershipOf(room, userId);
    if (current !== null && current.membership !== 'leave') {
      signer = await prepareSigner(signer);
    }
    return await room.tx((tx) =>
      withMembershipFence(admission, async () => {
        const current = await membershipInTx(tx, userId);
        if (current === null) {
          throw new MatrixError(
            403,
            'M_FORBIDDEN',
            'never a member of ' + room.id,
          );
        }
        if (current.membership === 'leave') {
          return {
            result: {
              roomId: room.id,
              eventId: current.eventId,
              created: false,
            },
            rejection: null,
          };
        }
        const content: Record<string, unknown> = { membership: 'leave' };
        if (reason !== undefined) content.reason = reason;
        const pdu = await buildInTx(tx, room.id, {
          type: 'm.room.member',
          sender: userId,
          state_key: userId,
          content,
        }, signer);
        const res = await ingestInTx(tx, room.id, pdu, {
          self: signer.serverName,
        });
        return {
          result: { roomId: room.id, eventId: res.eventId, created: true },
          rejection: res.standing === 'rejected'
            ? `membership rejected (${res.reason}, rule ${res.rule})`
            : null,
        };
      })
    );
  }).catch((error) => {
    if (
      String(error).includes('E_ROOM_ARCHIVED') ||
      String(error).includes('M_NO_CREATE')
    ) {
      throw new MatrixError(403, 'M_FORBIDDEN', String(error));
    }
    throw error;
  });
  // Replay also rolls forward a projection interrupted after the room commit.
  await afterLocalCommit(room, outcome.result.eventId, signer.serverName);
  if (outcome.rejection !== null) {
    throw new MatrixError(403, 'M_FORBIDDEN', outcome.rejection);
  }
  return outcome.result;
}

// invite: sender invites the target. Malformed target -> 400; self-invite
// -> 403; target already joined -> 403. The event is authored into the
// room; remote invitee transport is the caller's work (3c).
export async function invite(
  room: Room,
  sender: string,
  target: string,
  signer: Signer,
  reason?: string,
): Promise<MembershipOpResult> {
  if (!validEventUserId(target)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'not a user id: ' + target);
  }
  if (target === sender) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'cannot invite yourself');
  }
  const current = await membershipOf(room, target);
  if (current?.membership === 'join') {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      target + ' is already in the room',
    );
  }
  const content: Record<string, unknown> = { membership: 'invite' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(room, sender, target, content, signer);
}

// kick: a leave authored by someone else. The target must be in the room
// (join/invite/knock) — an op-layer check, as in Synapse's REST handler;
// the rulebook carries no target-membership condition.
export async function kick(
  room: Room,
  sender: string,
  target: string,
  signer: Signer,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(room, target);
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
  return await authorMember(room, sender, target, content, signer);
}

// ban: sender bans the target (any current membership; the rulebook
// decides — a non-present or under-powered sender gets a 403).
export async function ban(
  room: Room,
  sender: string,
  target: string,
  signer: Signer,
  reason?: string,
): Promise<MembershipOpResult> {
  const content: Record<string, unknown> = { membership: 'ban' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(room, sender, target, content, signer);
}

// unban: the spec's leave-from-ban — a member-leave for the target,
// authored by the sender (kick power, the rulebook decides). The target
// must be banned (400 M_BAD_STATE otherwise, Synapse's shape).
export async function unban(
  room: Room,
  sender: string,
  target: string,
  signer: Signer,
  reason?: string,
): Promise<MembershipOpResult> {
  const current = await membershipOf(room, target);
  if (current?.membership !== 'ban') {
    throw new MatrixError(
      400,
      'M_BAD_STATE',
      `${target} is not banned from ${room.id}`,
    );
  }
  const content: Record<string, unknown> = { membership: 'leave' };
  if (reason !== undefined) content.reason = reason;
  return await authorMember(room, sender, target, content, signer);
}

// Self-only archived reopen (§3.6b): the previous stay is the held
// snapshot; the join cites its grounded tips. No network or fake history.
export async function reopen(
  room: Room,
  userId: string,
  signer: Signer,
  content: Record<string, unknown>,
): Promise<MembershipOpResult> {
  return (await admitJoin(
    room,
    userId,
    signer,
    content,
    async (tx, prepared) => {
      const last = await tx.segments.latestStay();
      const group = last === null ? null : await tx.state.current(last.id);
      if (last === null || group === null) {
        throw new MatrixError(403, 'M_FORBIDDEN', 'no snapshot to reopen');
      }
      const prevs = await tx.extremities.parents(last.id);
      const stay = await tx.segments.create({
        kind: 'stay',
        prev: last.id,
        opening_group: group,
      });
      await tx.extremities.inherit(last.id, stay);
      await tx.segments.create({
        kind: 'history',
        prev: stay,
        status: 'complete',
      });
      const pdu = await buildInTx(tx, room.id, {
        type: 'm.room.member',
        sender: userId,
        state_key: userId,
        content: { ...content, membership: 'join' },
        prev_events: prevs,
      }, prepared);
      const res = await ingestInTx(tx, room.id, pdu, {
        self: signer.serverName,
      });
      if (res.standing !== 'accepted') {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          `membership rejected (${res.reason}, rule ${res.rule})`,
        );
      }
      await tx.segments.setOpenedBy(stay, res.eventId);
      return { roomId: room.id, eventId: res.eventId, created: true };
    },
  ))!;
}
