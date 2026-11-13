// Resident-side membership dances. Network verification precedes the room lock;
// the snapshot, lifecycle check and ingest share one critical section (R13).
import { config } from '#engine/config.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { projectAfterWrite } from '#engine/room/hooks.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { assertAcl } from '#engine/room/acl.ts';
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
import { verify, verifyJoinForCountersign } from '#engine/room/verify.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';
import { withRestrictedAdmission } from '#engine/room/restricted.ts';
import { loadRulebookStore } from '#engine/room/build.ts';
import { prejoinStateInTx } from './prejoin.ts';

async function template(
  roomId: string,
  userId: string,
  origin: string,
  versions: string[],
  membership: 'join' | 'leave' | 'knock',
  deps: InviteDeps,
) {
  if (domainOf(userId) !== origin) {
    throw new MatrixError(403, 'M_FORBIDDEN', `${userId} is not on ${origin}`);
  }
  const room = await heldRoom(deps.store, roomId);
  const build = async (
    tx: Parameters<Parameters<typeof room.tx>[0]>[0],
    authorizer: string | null = null,
  ) => {
    await assertAcl(tx, origin);
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
      content: {
        membership,
        ...(authorizer === null
          ? {}
          : { join_authorised_via_users_server: authorizer }),
      },
    };
    if (membership === 'knock') {
      const rulebook = getRulebook(version);
      if (!rulebook.spec.knockJoinRule || !versions.includes(version)) {
        throw new MatrixError(
          400,
          'M_INCOMPATIBLE_ROOM_VERSION',
          'knock room version not negotiated',
          {
            errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
            error: 'knock room version not negotiated',
            room_version: version,
          },
        );
      }
      if (stay.status !== 'open') {
        throw new MatrixError(404, 'M_NOT_FOUND', roomId);
      }
      const candidate: Pdu = {
        ...partial,
        room_id: roomId,
        prev_events: prevs,
        auth_events: rulebook.selectAuthEvents(
          partial as unknown as Pdu,
          state,
        ),
        depth: Math.max(0, ...[...depths.values()].map((r) => r.depth)) + 1,
        origin_server_ts: Date.now(),
        hashes: { sha256: '' },
        signatures: {},
      };
      const verdict = rulebook.checkAuthAgainstState(
        candidate,
        state,
        await loadRulebookStore(tx, [...state.values()]),
      );
      if (!verdict.ok) {
        throw new MatrixError(403, 'M_FORBIDDEN', verdict.reason);
      }
    }
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
  };
  return membership === 'join'
    ? await withRestrictedAdmission(room, userId, deps.self, build)
    : await room.tx((tx) => build(tx));
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

export function makeKnock(
  roomId: string,
  userId: string,
  origin: string,
  ver: string[],
  deps: InviteDeps,
) {
  return template(roomId, userId, origin, ver, 'knock', deps);
}

async function sendMembership(
  roomId: string,
  eventId: string,
  raw: unknown,
  origin: string,
  membership: 'join' | 'leave' | 'knock',
  apiVersion: 'v1' | 'v2',
  deps: InviteDeps,
) {
  const room = await heldRoom(deps.store, roomId);
  const version = await room.tx(async (tx) => {
    await assertAcl(tx, origin);
    return (await currentSnapshot(tx)).version;
  });
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
  const prepared =
    await (membership === 'join'
      ? verifyJoinForCountersign(pdu, version, deps.keys, deps.self, roomId)
      : verify(pdu, version, deps.keys, { roomId })).catch((error) => {
        if (!recoverableUpstream(error)) throw error;
        throw new MatrixError(403, 'M_FORBIDDEN', String(error));
      });
  const nominated = prepared.pdu.content?.join_authorised_via_users_server;
  if (membership === 'join') {
    await withRestrictedAdmission(
      room,
      pdu.sender,
      deps.self,
      (_tx, authorizer) => {
        if (authorizer !== null && nominated === undefined) {
          throw new MatrixError(
            403,
            'M_FORBIDDEN',
            'restricted join has no authorizer',
          );
        }
      },
      typeof nominated === 'string' ? nominated : undefined,
    );
  }
  await countersign(prepared.pdu, version, deps.signer);
  // Keys/network stay outside the publication lock. Our freshly added
  // signature is verified locally; every other required signer uses resolver.
  const verified = await verify(prepared.pdu, version, {
    verifyEventSignature: (args) =>
      args.server === deps.self && args.keyId === deps.signer.keyId
        ? Promise.resolve(true)
        : deps.keys.verifyEventSignature(args),
  }, { roomId });
  const publish = async (tx: Parameters<Parameters<typeof room.tx>[0]>[0]) => {
    await assertAcl(tx, origin);
    const snapshot = await currentSnapshot(tx);
    if (
      membership === 'knock' &&
      (!getRulebook(version).spec.knockJoinRule ||
        snapshot.stay.status !== 'open')
    ) {
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        'room does not support knocking',
      );
    }
    if (!(await serverInState(tx, snapshot.state, deps.self))) {
      if (membership !== 'leave' || snapshot.stay.status !== 'closed') {
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
    if (membership === 'knock') {
      return { knock_room_state: await prejoinStateInTx(tx, pdu.sender) };
    }
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
  };
  const answer = membership === 'join'
    ? await withRestrictedAdmission(
      room,
      pdu.sender,
      deps.self,
      publish,
      typeof nominated === 'string' ? nominated : undefined,
    )
    : await withRoomLock(roomId, () => room.tx(publish));
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

export function sendKnock(
  roomId: string,
  eventId: string,
  pdu: unknown,
  origin: string,
  deps: InviteDeps,
) {
  return sendMembership(roomId, eventId, pdu, origin, 'knock', 'v1', deps);
}
