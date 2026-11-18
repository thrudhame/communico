// Resident-side membership dances. Network verification precedes the room lock;
// the snapshot, lifecycle check and ingest share one critical section (R13).
import { config } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { createHash } from 'node:crypto';
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
import {
  eventMaterial,
  verify,
  verifyJoinForCountersign,
} from '#engine/room/verify.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';
import { withRestrictedAdmission } from '#engine/room/restricted.ts';
import {
  loadRulebookStore,
  resolvePrevs,
  stateBefore,
} from '#engine/room/build.ts';
import { prejoinStateInTx } from './prejoin.ts';
import { joinResponse } from './join-response.ts';

async function membershipRoom(
  deps: InviteDeps,
  roomId: string,
  scopePrepared = false,
) {
  try {
    return await heldRoom(deps.store, roomId);
  } catch (error) {
    if (
      error instanceof MatrixError && error.status === 404 &&
      deps.prepareRoomScope
    ) {
      // A directory-proved absence throws404 from preparation. A complete
      // required scope without its file is unavailable, not known absence.
      if (!scopePrepared) await deps.prepareRoomScope(roomId);
      throw new MatrixError(503, 'M_UNAVAILABLE', 'room replica unavailable');
    }
    throw error;
  }
}

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
  const admission = await deps.prepareRoomScope?.(roomId);
  const room = await membershipRoom(deps, roomId, admission !== undefined);
  const build = async (
    tx: Parameters<Parameters<typeof room.tx>[0]>[0],
    authorizer: string | null = null,
  ) => {
    admission?.checkCurrent();
    await assertAcl(tx, origin);
    const snapshot = await currentSnapshot(tx);
    const { version, stay } = snapshot;
    if (versions.length > 0 && !versions.includes(version)) {
      const error =
        `This server does not know how to join a room of version ${version}`;
      throw new MatrixError(400, 'M_INCOMPATIBLE_ROOM_VERSION', error, {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error,
        room_version: version,
      });
    }
    // Current admission and the event's DAG state are separate contracts.
    // A bounded parent set must not borrow auth from an omitted frontier head.
    const prevs = await tx.extremities.parents(stay.id);
    const parents = await resolvePrevs(tx, prevs);
    const state = await stateBefore(
      tx,
      parents.afterGroups,
      getRulebook(version),
    );
    for (const admitted of [snapshot.state, state]) {
      const contentAt = async (type: string, key = '') => {
        const id = admitted.get(type + '\0' + key);
        const pdu = id === undefined ? null : await pduAt(tx, id);
        return pdu === null || pdu.content == null ? {} : pdu.content;
      };
      const joinRule = (await contentAt('m.room.join_rules')).join_rule;
      const current = (await contentAt('m.room.member', userId)).membership;
      if (current === 'ban') {
        throw new MatrixError(403, 'M_FORBIDDEN', `${userId} is banned`);
      }
      if (
        membership === 'join' && joinRule === 'invite' &&
        current !== 'invite' &&
        current !== 'join'
      ) {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          `${userId} has no invite to ${roomId}`,
        );
      }
      if (membership === 'leave' && current === undefined) {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          `${userId} is not in the room`,
        );
      }
    }
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
        depth: Math.max(0, ...parents.depths) + 1,
        origin_server_ts: Date.now(),
        hashes: { sha256: '' },
        signatures: {},
      };
      const auth = await loadRulebookStore(
        tx,
        [...state.values(), ...snapshot.state.values()],
      );
      for (const admitted of [state, snapshot.state]) {
        const verdict = rulebook.checkAuthAgainstState(
          candidate,
          admitted,
          auth,
        );
        if (!verdict.ok) {
          throw new MatrixError(403, 'M_FORBIDDEN', verdict.reason);
        }
      }
    }
    admission?.checkCurrent();
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
        depth: Math.max(0, ...parents.depths) + 1,
        origin: deps.self,
        origin_server_ts: Date.now(),
      },
    };
  };
  const recheck = async () => {
    if (admission) await deps.server.tx(admission.check);
  };
  if (membership === 'join') {
    return await withRestrictedAdmission(
      room,
      userId,
      deps.self,
      build,
      undefined,
      recheck,
    );
  }
  await recheck();
  return await room.tx((tx) => build(tx));
}

export function makeJoin(
  roomId: string,
  userId: string,
  origin: string,
  ver: string[],
  deps: InviteDeps,
) {
  return template(
    roomId,
    userId,
    origin,
    ver.length === 0 ? ['1'] : ver,
    'join',
    deps,
  );
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
  omitMembers = false,
) {
  const room = await membershipRoom(deps, roomId);
  const operation = canonicalJson([origin, membership, eventId]);
  // Presence of a room file proves no replica cut. Only completed operation
  // identities may reach authentication/replay without new-work admission.
  const completed = await room.tx((tx) => tx.membershipReceipts.has(operation));
  let admission = completed ? undefined : await deps.prepareRoomScope?.(roomId);
  const version = await room.tx(async (tx) => {
    // A completed operation is replayable after an ACL update. New work keeps
    // the normal current-ACL admission order, including malformed requests.
    // Existence alone exposes no saved result; authentication remains below.
    if (!await tx.membershipReceipts.has(operation)) {
      await assertAcl(tx, origin);
    }
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
  const inputHash = createHash('sha256').update(
    eventMaterial({ ...pdu, event_id: eventId }),
  ).digest('hex');
  const finish = async (result: Record<string, unknown>) => {
    // A saved result closes room mutation, not its derived publication. Both
    // new and replayed operations finish through the same roll-forward owner.
    await projectAfterWrite(deps.store, roomId);
    if (membership === 'knock') return result;
    if (membership === 'leave') {
      return apiVersion === 'v2' ? result : [200, result];
    }
    return await joinResponse(result, version, apiVersion, omitMembers);
  };
  // A completed protocol operation survives later ACL/membership/key changes.
  // Current request origin/signature checks above still precede the receipt.
  const retained = await room.tx((tx) =>
    tx.membershipReceipts.get(operation, inputHash)
  );
  if (retained !== null) return await finish(retained);
  // If an observed receipt disappeared, its existence is not an admission for
  // a second mutation. The normal retained-material collision check ran above.
  if (admission === undefined) {
    admission = await deps.prepareRoomScope?.(roomId);
  }
  const recheck = async () => {
    if (admission) await deps.server.tx(admission.check);
  };
  const prepared =
    await (membership === 'join'
      ? verifyJoinForCountersign(pdu, version, deps.keys, deps.self, roomId)
      : verify(pdu, version, deps.keys, { roomId })).catch((error) => {
        if (!recoverableUpstream(error)) throw error;
        throw new MatrixError(403, 'M_FORBIDDEN', String(error));
      });
  const nominated = prepared.pdu.content?.join_authorised_via_users_server;
  admission?.checkCurrent();
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
      recheck,
    );
  }
  admission?.checkCurrent();
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
    const retained = await tx.membershipReceipts.get(operation, inputHash);
    if (retained !== null) return retained;
    admission?.checkCurrent();
    const save = async (response: Record<string, unknown>) => {
      const saved = await tx.membershipReceipts.save(
        operation,
        inputHash,
        response,
      );
      admission?.checkCurrent();
      return saved;
    };
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
    admission?.checkCurrent();
    if (membership === 'leave') {
      return await save({});
    }
    if (membership === 'knock') {
      const state = await prejoinStateInTx(tx, pdu.sender);
      admission?.checkCurrent();
      return await save({
        knock_room_state: state,
      });
    }
    // Pin the event's actual pre-state, not a later current-state projection.
    const before = await tx.state.eventStateBefore(eventId);
    if (before === null) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'join pre-state unavailable');
    }
    const ids = [...(await tx.state.groupMap(before.group)).values()];
    const declaredAuth = pdu.auth_events == null ? [] : pdu.auth_events;
    const closure = await authClosure(tx, [...ids, ...declaredAuth]);
    const state = ids.map((id) => closure.pdus.get(id)).filter((p): p is Pdu =>
      p !== undefined
    );
    const chain = new Set([...closure.ids, ...declaredAuth]);
    const auth = [...chain].map((id) => closure.pdus.get(id)).filter((
      p,
    ): p is Pdu => p !== undefined);
    const event = toWire(verified.pdu, version);
    const response = {
      state: state.map((p) => toWire(p, version)),
      auth_chain: auth.map((p) => toWire(p, version)),
      event,
      servers_in_room: [
        ...new Set(
          state.filter((p) =>
            p.type === 'm.room.member' && p.content?.membership === 'join'
          ).map((p) => domainOf(String(p.state_key))),
        ),
      ].sort(),
    };
    admission?.checkCurrent();
    return await save(response);
  };
  const answer = membership === 'join'
    ? await withRestrictedAdmission(
      room,
      pdu.sender,
      deps.self,
      publish,
      typeof nominated === 'string' ? nominated : undefined,
      recheck,
    )
    : await withRoomLock(roomId, async () => {
      await recheck();
      return await room.tx(publish);
    });
  return await finish(answer);
}

export function sendJoin(
  roomId: string,
  eventId: string,
  pdu: unknown,
  origin: string,
  apiVersion: 'v1' | 'v2',
  deps: InviteDeps,
  omitMembers = false,
) {
  return sendMembership(
    roomId,
    eventId,
    pdu,
    origin,
    'join',
    apiVersion,
    deps,
    omitMembers,
  );
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
