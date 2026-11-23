import { theApp } from '#engine/app.ts';
import { serverName } from '#engine/config.ts';
import { localpartOf, validEventUserId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { federationRequest } from '#engine/federation/client.ts';
import { directoryResponse } from '#engine/federation/discovery-response.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import {
  inviteFor,
  inviteRemote,
  markInviteJoined,
  rejectInviteRemote,
} from '#engine/federation/invites.ts';
import { joinRemote } from '#engine/room/join.ts';
import { restrictedResidents } from '#engine/room/restricted.ts';
import { performJoinCleanup } from '#engine/federation/join-cleanup.ts';
import { knockRemote } from '#engine/federation/knocks.ts';
import { assertKnownJoinEncryption } from '#engine/room/encryption-policy.ts';
import * as local from '#engine/room/membership.ts';
import { lookupAlias } from '#engine/server/aliases.ts';
import { membershipOf, roomsFor } from '#engine/server/read.ts';
import {
  clearPurgeable,
  forget as markForgotten,
} from '#engine/server/membership.ts';
import { getProfile } from '#engine/tenant/users.ts';
import {
  lookupRoomForAdmission,
  requireRoomForAdmission,
  type RoomAccess,
  stateAtSeq,
} from './room.ts';
import { inviteDeps } from './write.ts';

export async function serversInRoom(
  roomId: string,
  access: RoomAccess = 'read',
): Promise<string[]> {
  const members = (await stateAtSeq(roomId, null, undefined, access)).filter((
    r,
  ) => r.type === 'm.room.member' && r.content.membership === 'join');
  return [...new Set(members.map((r) => domainOf(r.stateKey)))].sort();
}

// Keep candidate provenance at the client composition boundary. Explicit
// remote choices and automatic resident discovery are distinct inputs.
export function remoteJoinCandidates(
  self: string,
  explicit: readonly string[],
  invited: readonly string[],
  qualified: readonly string[],
  held: readonly string[],
): string[] {
  const requested = [...new Set(explicit)].filter((server) => server !== self);
  if (requested.length > 0) return requested;
  return [...new Set([...invited, ...qualified, ...held])]
    .filter((server) => server !== self);
}

export async function join(
  roomId: string,
  userId: string,
  extra: Record<string, unknown> = {},
  opts: { via?: string[] } = {},
) {
  const app = theApp();
  const signer = app.tenant.signer();
  const profile = await getProfile(
    app.tenant,
    localpartOf(userId),
  );
  const content = { ...profile, ...extra, membership: 'join' };
  const room = await lookupRoomForAdmission(roomId);
  let result;
  if (room !== null) {
    try {
      result = await local.joinResident(room, userId, signer, content) ??
        undefined;
    } catch (error) {
      const code = (error as { errcode?: string }).errcode;
      if (
        code !== 'M_UNABLE_TO_AUTHORISE_JOIN' &&
        code !== 'M_UNABLE_TO_GRANT_JOIN'
      ) throw error;
    }
  }
  if (result === undefined) {
    const deps = inviteDeps();
    const invitation = await inviteFor(roomId, userId, deps);
    const held = room === null ? [] : await serversInRoom(roomId, 'admission');
    const qualified = room === null
      ? []
      : await restrictedResidents(room, userId);
    const via = remoteJoinCandidates(
      serverName(),
      opts.via ?? [],
      invitation?.status === 'pending' ? [invitation.origin] : [],
      qualified,
      held,
    );
    if (via.length === 0) {
      if (room === null) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'no servers to join through');
      }
      result = await local.reopen(room, userId, signer, content);
    } else {
      const remote = await joinRemote(app.store, {
        roomId,
        user: userId,
        via,
        signer,
        content,
        deps: {
          keys: deps.keys,
          fetcher: productionFetcher(app.server, signer, app.store),
          self: serverName(),
          leave: async (attempt) => {
            await performJoinCleanup(deps, attempt);
          },
          wake: deps.wake,
        },
      });
      result = { ...remote, created: true };
    }
    await markInviteJoined(roomId, userId, deps);
  }
  await clearPurgeable(app.server, roomId, userId);
  return result;
}

export async function joinByIdOrAlias(
  id: string,
  userId: string,
  content: Record<string, unknown>,
  via: string[],
  operation: typeof join = join,
) {
  const app = theApp();
  let roomId = id;
  const candidates: string[] = [];
  if (id.startsWith('#')) {
    const mapped = await lookupAlias(app.server, id);
    if (mapped !== null) roomId = mapped;
    else {
      const destination = domainOf(id);
      if (destination === serverName()) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'unknown alias: ' + id);
      }
      const res = await federationRequest(app.server, app.tenant.signer(), {
        destination,
        method: 'GET',
        path: '/_matrix/federation/v1/query/directory?room_alias=' +
          encodeURIComponent(id),
        body: null,
      });
      const answer = directoryResponse(res.json);
      roomId = answer.room_id;
      candidates.push(
        destination,
        ...answer.servers,
      );
    }
  }
  candidates.push(...via);
  if (candidates.length === 0 && roomId.includes(':')) {
    candidates.push(domainOf(roomId));
  }
  return await operation(roomId, userId, content, {
    via: [...new Set(candidates)].filter((s) => s !== serverName()),
  });
}

export async function knock(
  roomId: string,
  userId: string,
  extra: Record<string, unknown> = {},
  opts: { via?: string[] } = {},
) {
  const app = theApp();
  const profile = await getProfile(app.tenant, localpartOf(userId));
  const content = {
    ...profile,
    ...(typeof extra.reason === 'string' ? { reason: extra.reason } : {}),
    membership: 'knock',
  };
  await assertKnownJoinEncryption(app.store, roomId);
  const room = await lookupRoomForAdmission(roomId);
  if (room !== null && await room.tx((tx) => tx.segments.openStay()) !== null) {
    const result = await local.knock(
      room,
      userId,
      app.tenant.signer(),
      content,
    );
    await clearPurgeable(app.server, roomId, userId);
    return result;
  }
  const via = [...new Set(opts.via ?? [])].filter((s) => s !== serverName());
  return await knockRemote(roomId, userId, content, via, inviteDeps());
}

export async function leave(roomId: string, userId: string, reason?: string) {
  const app = theApp();
  const deps = inviteDeps();
  const invitation = await inviteFor(roomId, userId, deps);
  const room = await lookupRoomForAdmission(roomId);
  const current = await membershipOf(app.server, roomId, userId, 'admission');
  if (
    (current === null || current.seq < (invitation?.seq ?? 0)) &&
    invitation !== null && invitation.status !== 'joined'
  ) {
    await rejectInviteRemote(roomId, userId, deps, reason);
    return { roomId, eventId: invitation.eventId, created: false };
  }
  if (room === null) {
    throw new MatrixError(404, 'M_NOT_FOUND', 'room not found: ' + roomId);
  }
  return await local.leave(room, userId, app.tenant.signer(), reason);
}

export async function memberOperation(
  op: 'invite' | 'kick' | 'ban' | 'unban',
  roomId: string,
  userId: string,
  target: string,
  reason?: string,
) {
  const room = await requireRoomForAdmission(roomId);
  const app = theApp();
  let result;
  if (op === 'invite' && domainOf(target) !== serverName()) {
    if (!validEventUserId(target)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'not a user id: ' + target);
    }
    if (
      target === userId ||
      (await membershipOf(app.server, roomId, target, 'admission'))
          ?.membership === 'join'
    ) throw new MatrixError(403, 'M_FORBIDDEN', 'cannot invite this user');
    result = await inviteRemote(
      roomId,
      userId,
      target,
      reason,
      undefined,
      inviteDeps(),
    );
  } else {result = await local[op](
      room,
      userId,
      target,
      app.tenant.signer(),
      reason,
    );}
  if (op === 'invite') await clearPurgeable(app.server, roomId, target);
  return result;
}

export async function forget(roomId: string, userId: string) {
  await markForgotten(theApp().server, roomId, userId, serverName());
}
export async function joinedRooms(userId: string) {
  // Complete-list consumers must admit the inventory before an empty local
  // projection can be mistaken for complete nonmembership.
  await theApp().replica?.requireScope('rooms');
  return (await roomsFor(theApp().server, userId)).filter((m) =>
    m.membership === 'join'
  ).map((m) => m.roomId);
}

export async function propagateProfile(
  userId: string,
  _field: 'displayname' | 'avatar_url',
) {
  const app = theApp();
  if (!app.profileFanout) {
    throw new MatrixError(503, 'M_UNAVAILABLE', 'profile fanout unavailable');
  }
  const failures = await app.profileFanout.drain(localpartOf(userId));
  if (failures.length > 0) {
    const error = new MatrixError(
      503,
      'M_UNKNOWN',
      'profile saved but some room memberships were not updated',
      {
        errcode: 'M_UNKNOWN',
        error: 'profile saved but some room memberships were not updated',
        failed_rooms: failures.map((failure) => failure.room),
      },
    );
    error.cause = new AggregateError(
      failures.map((failure) =>
        new Error('profile update failed for ' + failure.room, {
          cause: failure.error,
        })
      ),
    );
    console.error('profile propagation:', error.cause);
    throw error;
  }
}
