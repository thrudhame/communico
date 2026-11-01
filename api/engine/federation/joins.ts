// Resident-side membership dances. Network verification precedes the room lock;
// the snapshot, lifecycle check and ingest share one critical section (R13).
import { config } from '#engine/config.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { projectAfterWrite } from '#engine/room/hooks.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import type { InviteDeps } from './invites.ts';
import { countersign } from './invites.ts';
import { domainOf, toWire } from './pdu.ts';
import {
  authClosure,
  currentSnapshot,
  heldRoom,
  pduAt,
  serverInState,
} from './room.ts';
import { verify } from '#engine/room/verify.ts';

async function template(
  roomId: string,
  userId: string,
  origin: string,
  versions: string[],
  membership: 'join' | 'leave',
  deps: InviteDeps,
) {
  if (domainOf(userId) !== origin) {
    throw new MatrixError(403, 'M_FORBIDDEN', `${userId} is not on ${origin}`);
  }
  const room = await heldRoom(deps.store, roomId);
  return await room.tx(async (tx) => {
    const snapshot = await currentSnapshot(tx);
    const { version, state, stay } = snapshot;
    if (versions.length > 0 && !versions.includes(version)) {
      const error =
        `This server does not know how to join a room of version ${version}`;
      throw new MatrixError(400, 'M_INCOMPATIBLE_ROOM_VERSION', error, {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error,
        room_version: version,
      });
    }
    const contentAt = async (type: string, key = '') => {
      const id = state.get(type + '\0' + key);
      const pdu = id === undefined ? null : await pduAt(tx, id);
      return pdu === null || pdu.content == null ? {} : pdu.content;
    };
    const joinRule = (await contentAt('m.room.join_rules')).join_rule;
    if (joinRule === 'restricted') {
      throw new MatrixError(
        400,
        'M_UNABLE_TO_AUTHORISE_JOIN',
        'restricted rooms are M5c',
      );
    }
    const current = (await contentAt('m.room.member', userId)).membership;
    if (current === 'ban') {
      throw new MatrixError(403, 'M_FORBIDDEN', `${userId} is banned`);
    }
    if (
      membership === 'join' && joinRule === 'invite' && current !== 'invite' &&
      current !== 'join'
    ) {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        `${userId} has no invite to ${roomId}`,
      );
    }
    if (membership === 'leave' && current === undefined) {
      throw new MatrixError(403, 'M_FORBIDDEN', `${userId} is not in the room`);
    }
    const prevs = await tx.extremities.frontier(stay.id);
    const depths = await tx.events.list(prevs);
    const partial = {
      type: 'm.room.member',
      state_key: userId,
      sender: userId,
      content: { membership },
    };
    return {
      room_version: version,
      event: {
        ...partial,
        room_id: roomId,
        prev_events: prevs,
        auth_events: getRulebook(version).selectAuthEvents(
          partial as unknown as Pdu,
          state,
        ),
        depth: Math.max(0, ...[...depths.values()].map((r) => r.depth)) + 1,
        origin: deps.self,
        origin_server_ts: Date.now(),
      },
    };
  });
}

export function makeJoin(
  roomId: string,
  userId: string,
  origin: string,
  ver: string[],
  deps: InviteDeps,
) {
  return template(roomId, userId, origin, ver, 'join', deps);
}

export function makeLeave(
  roomId: string,
  userId: string,
  origin: string,
  ver: string[],
  deps: InviteDeps,
) {
  return template(roomId, userId, origin, ver, 'leave', deps);
}

async function sendMembership(
  roomId: string,
  eventId: string,
  raw: unknown,
  origin: string,
  membership: 'join' | 'leave',
  apiVersion: 'v1' | 'v2',
  deps: InviteDeps,
) {
  const room = await heldRoom(deps.store, roomId);
  const version = await room.tx(async (tx) =>
    (await currentSnapshot(tx)).version
  );
  const pdu = raw as Pdu;
  if (pdu.room_id !== roomId) {
    throw new MatrixError(400, 'M_BAD_JSON', 'room_id does not match the path');
  }
  if (
    pdu.type !== 'm.room.member' || pdu.state_key !== pdu.sender ||
    pdu.content?.membership !== membership
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      `expected an m.room.member ${membership} with state_key === sender`,
    );
  }
  if (domainOf(String(pdu.sender)) !== origin) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `${String(pdu.sender)} is not on ${origin}`,
    );
  }
  if (
    await eventIdFor(pdu as unknown as Record<string, unknown>, version) !==
      eventId
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'event id does not match the path',
    );
  }
  let sigOk = false;
  const signatures = pdu.signatures == null ? {} : pdu.signatures;
  const originKeys = signatures[origin] == null ? {} : signatures[origin];
  for (const kid of Object.keys(originKeys)) {
    if (
      await deps.keys.verifyEventSignature({
        server: origin,
        keyId: kid,
        pdu,
        roomVersion: version,
        minValidUntilMs: Date.now(),
      })
    ) sigOk = true;
  }
  if (!sigOk) throw new MatrixError(403, 'M_FORBIDDEN', 'bad signature');
  const verified = await verify(pdu, version, deps.keys, { roomId });
  await countersign(verified.pdu, version, deps.signer);
  const answer = await withRoomLock(roomId, () =>
    room.tx(async (tx) => {
      const snapshot = await currentSnapshot(tx);
      if (!(await serverInState(tx, snapshot.state, deps.self))) {
        if (membership === 'join' || snapshot.stay.status !== 'closed') {
          throw new MatrixError(404, 'M_NOT_FOUND', roomId);
        }
      }
      const ids = [...snapshot.state.values()];
      const declaredAuth = pdu.auth_events == null ? [] : pdu.auth_events;
      const closure = await authClosure(tx, [
        ...ids,
        ...declaredAuth,
      ]);
      const state = ids.map((id) => closure.pdus.get(id)).filter((
        p,
      ): p is Pdu => p !== undefined);
      const chain = new Set([...closure.ids, ...declaredAuth]);
      const auth = [...chain].map((id) => closure.pdus.get(id)).filter((
        p,
      ): p is Pdu => p !== undefined);
      const result = await ingestInTx(tx, roomId, verified.pdu, {
        remote: {
          origin,
          self: deps.self,
          oversized: verified.oversized,
          ungroundedMs: config().federation.ungroundedmillihours * 3600,
          residentMembership: true,
        },
      });
      if (result.standing !== 'accepted' || result.grounding !== 'grounded') {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          `membership rejected (${result.reason})`,
        );
      }
      if (membership === 'leave') return apiVersion === 'v2' ? {} : [200, {}];
      const event = toWire(verified.pdu, version);
      const response = {
        state: state.map((p) => toWire(p, version)),
        auth_chain: auth.map((p) => toWire(p, version)),
        event,
      };
      return apiVersion === 'v1' ? [200, response] : {
        ...response,
        members_omitted: false,
        servers_in_room: [deps.self],
      };
    }));
  await projectAfterWrite(deps.store, roomId);
  return answer;
}

export function sendJoin(
  roomId: string,
  eventId: string,
  pdu: unknown,
  origin: string,
  apiVersion: 'v1' | 'v2',
  deps: InviteDeps,
) {
  return sendMembership(roomId, eventId, pdu, origin, 'join', apiVersion, deps);
}

export function sendLeave(
  roomId: string,
  eventId: string,
  pdu: unknown,
  origin: string,
  apiVersion: 'v1' | 'v2',
  deps: InviteDeps,
) {
  return sendMembership(
    roomId,
    eventId,
    pdu,
    origin,
    'leave',
    apiVersion,
    deps,
  );
}
