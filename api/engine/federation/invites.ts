// api/engine/federation/invites.ts — invites both ways (§3.8).
//
// INVITER (a local user invites @x:remote): admit → author → PUT
// /v2/invite with the stripped invite_room_state → merge the invitee's
// signature → ingest as our own (we authored it — the strict local
// checks apply; r6, gemini).
//
// INVITEE (PUT /v2/invite): validate, countersign with our tenant
// signer, answer { event }; a room we do not hold stores a
// federation_invites row (no room file is provisioned for an invite —
// its owner is the server file, stripped state kept) so the invitee
// sees it.
//
// REJECT (ruling F): local effect at once (the row goes 'rejecting' —
// the invitee sees the invite gone) + a durable intent the sender's
// per-destination loop performs on the ladder: the make_leave/send_leave
// dance against the inviter first, then any server named in the
// stripped state. No silent local-only fallback. The durable truth is
// the local prejoin job, separate from display; the candidate
// progress is in-memory — a restart resumes from the first candidate
// (the inviter, always a correct first retry).
//
// RESCIND: an m.room.member leave/ban for a user with a
// federation_invites row, from the inviter, is a remote rejection
// (tuwunel is the only prior art, handle_incoming_pdu.rs:125-133).
import { canonicalJson } from '#engine/canonical.ts';
import { createHash } from 'node:crypto';
import { config } from '#engine/config.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { eventMaterial, verify } from '#engine/room/verify.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  buildInTx,
  checkDeclaredAuth,
  finalizeBuilt,
  loadRulebookStore,
  roomVersionOf,
} from '#engine/room/build.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import { ingestLocal } from '#engine/room/ingest.ts';
import { withMembershipFence } from '#engine/room/hooks.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { prepareSigner, type Signer } from '#engine/room/signer.ts';
import { getRulebook, supportedRoomVersions } from '#engine/rulebook/index.ts';
import type { Conn, Database as Db } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { eventStreamTx, nextEventSeq } from '#engine/server/stream.ts';
import { withProjectionLock } from '#engine/server/project.ts';
import { prepareInvitePush } from '#engine/server/push-project.ts';
import {
  applyInvitePush,
  withdrawInvitePush,
} from '#engine/server/notifications.ts';
import {
  FederationHttpError,
  federationRequest,
  isDefiniteFederationRefusal,
  isEndpointUnknown,
} from './client.ts';
import {
  inviteResponse,
  leaveResponse,
  membershipTemplate,
} from './responses.ts';
import {
  recoverableUpstream,
  UpstreamError,
} from '#engine/net/upstream-error.ts';
import { assertRoomAcl } from './acl.ts';
import { assertAcl } from '#engine/room/acl.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { admit } from './gate.ts';
import { domainOf, toWire } from './pdu.ts';
import { prejoinState, validatePrejoin } from './prejoin.ts';
import {
  beginPrejoinLeave,
  prejoinLeaveActive,
  prejoinResult,
  savePrejoinResult,
  settleSupersededPrejoin,
  visiblePrejoin,
} from '#engine/server/prejoin.ts';
import { performKnockAttempt } from './knocks.ts';
import { recordMembershipOperation } from '#engine/server/membership-operations.ts';
import {
  beginPrejoinJob,
  createPrejoinJob,
  type PrejoinJob,
  prejoinJob,
  prejoinJobActive,
  prejoinJobId,
  prejoinJobs,
  type PrejoinWork,
  prejoinWorkOf,
  retractPrejoinKnock,
  supersedePrejoinKnocks,
  updatePrejoinJob,
} from '#engine/server/prejoin-jobs.ts';
import type {
  IntentJob,
  ReviewableIntentProvider,
  ReviewIntent,
} from './sender.ts';

export type InviteDeps = {
  store: Store;
  server: Db;
  // the tenant's event signer — countersigns inbound invites, signs the
  // authored invite and the leave of a rejection
  signer: Signer;
  keys: KeyResolver;
  // our server name (the invitee-domain and stripped-candidate checks)
  self: string;
  // the sender's public wake (the reject intent queues on the loop)
  wake: (destination: string) => void;
  // Replica composition supplies new-work admission. Durable checks belong to
  // the server file; room callbacks use only the synchronous receive fence.
  prepareRoomScope?: (
    roomId: string,
    allowAbsent?: boolean,
    localUser?: string,
  ) => Promise<{
    check(conn: Conn): Promise<void>;
    checkCurrent(): void;
  }>;
};

// OOB invite transitions share projection's lifecycle lane. A removal captures
// candidate ownership and cleans up under that same lane, so neither new
// rejections nor sender failover can invalidate its durable cut.
function inviteTransition<T>(server: Db, fn: (tx: Conn) => Promise<T>) {
  return withProjectionLock(() => eventStreamTx(server, fn));
}

// The spec's stripped-state list (CS:2810-2827) + the inviter's member
// event; each stripped to type, state_key, content, sender (CS:2795-2796)
// — the create entry keeps origin_server_ts (MSC-4311's "full create
// event" shape; narrowed conformance note, CS:2830-2832).

// Countersign a received PDU with the tenant signer: the signature
// covers the redacted form + hashes, the id rides out-of-band; existing
// signatures (the inviter's) are kept. (The old signPdu's merge.)
// Exported for the resident-side join/leave answers (stage 5's serving
// and the tests' instance harness ride the same merge).
export async function countersign(
  pdu: Pdu,
  roomVersion: string,
  signer: Signer,
): Promise<void> {
  const redacted = redact(
    pdu as unknown as Record<string, unknown>,
    roomVersion,
  );
  delete redacted.event_id;
  const existing =
    (redacted.signatures == null ? {} : redacted.signatures) as Record<
      string,
      Record<string, string>
    >;
  delete redacted.signatures;
  const signature = await signer.sign(canonicalJson(redacted));
  const ours = existing[signer.serverName] == null
    ? {}
    : existing[signer.serverName];
  ours[signer.keyId] = signature;
  existing[signer.serverName] = ours;
  pdu.signatures = existing;
}

// --- INVITER ---------------------------------------------------------------

type OutboundInvite = {
  roomId: string;
  sender: string;
  target: string;
  eventId: string;
  destination: string;
  request: {
    room_version: string;
    event: Record<string, unknown>;
    invite_room_state: unknown[];
  };
  response: Pdu | null;
  mayHaveApplied: boolean;
};
function outboundInvite(row: Record<string, unknown>): OutboundInvite {
  return {
    roomId: String(row.room_id),
    sender: String(row.sender),
    target: String(row.target),
    eventId: String(row.event_id),
    destination: String(row.destination),
    mayHaveApplied: Boolean(row.may_have_applied),
    request: JSON.parse(String(row.request_json)),
    response: row.response_json === null
      ? null
      : JSON.parse(String(row.response_json)),
  };
}
// The existing sender owns cold recovery; a live synchronous caller is merely
// another performer of that same durable operation, never a second attempt.
const activeInvites = new WeakMap<Store, Set<string>>();
function invitePerformers(store: Store): Set<string> {
  let active = activeInvites.get(store);
  if (!active) activeInvites.set(store, active = new Set());
  return active;
}

export async function inviteRemote(
  roomId: string,
  sender: string,
  target: string,
  reason: string | undefined,
  opts: { isDirect?: boolean } | undefined,
  deps: InviteDeps,
): Promise<{ eventId: string }> {
  const remote = domainOf(target);
  const room = await openRoom(deps.store, roomId, { admit: deps.signer.admit });
  await room.tx(async (tx) => {
    await assertAcl(tx, remote);
    await assertAcl(tx, deps.self);
  });
  // roster growth by intent (closed mode → 403 to the client, pending row)
  await admit(deps.server, remote, {
    kind: 'outbound',
    user: sender,
    what: 'invite',
  });
  const content: Record<string, unknown> = { membership: 'invite' };
  if (reason !== undefined) content.reason = reason;
  if (opts?.isDirect === true) content.is_direct = true;
  // Capture authority before the lock/room transaction, but do not require a new
  // signing permit when continuing previously prepared work.
  const existing = await deps.server.query(
    'SELECT * FROM federation_invite_attempts WHERE room_id=? AND sender=? AND target=?',
    [roomId, sender, target],
  );
  const replacing = existing.length > 0 && existing[0].status === 'refused' &&
    !outboundInvite(existing[0]).mayHaveApplied &&
    canonicalJson(outboundInvite(existing[0]).request.event.content) !==
      canonicalJson(content);
  const continuing = existing.length > 0 && !replacing;
  const admission = continuing
    ? undefined
    : await deps.prepareRoomScope?.(roomId, false, sender);
  const permit = continuing ? null : await prepareSigner(deps.signer);
  const attempt = await withRoomLock(roomId, async () => {
    if (await deps.store.roomRetired(roomId)) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'room removal is pending');
    }
    const rows = await deps.server.query(
      'SELECT * FROM federation_invite_attempts WHERE room_id=? AND sender=? AND target=?',
      [roomId, sender, target],
    );
    let saved: OutboundInvite;
    const replace = rows.length > 0 && rows[0].status === 'refused' &&
      !outboundInvite(rows[0]).mayHaveApplied &&
      canonicalJson(outboundInvite(rows[0]).request.event.content) !==
        canonicalJson(content);
    if (
      rows.length && invitePerformers(deps.store).has(String(rows[0].event_id))
    ) {
      throw new MatrixError(409, 'M_BAD_STATE', 'Remote invite is active');
    }
    if (rows.length && !replace) {
      saved = outboundInvite(rows[0]);
      if (
        canonicalJson(saved.request.event.content) !== canonicalJson(content)
      ) {
        throw new MatrixError(
          409,
          'M_BAD_STATE',
          'A different remote invite is pending',
        );
      }
    } else {
      if (permit === null) {
        throw new MatrixError(
          409,
          'M_BAD_STATE',
          'Remote invite completed concurrently',
        );
      }
      const { version, pdu } = await room.tx((tx) =>
        withMembershipFence(admission, tx, async () => {
          await assertAcl(tx, remote);
          await assertAcl(tx, deps.self);
          const stay = await tx.segments.openStay();
          if (stay === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
          const version = await roomVersionOf(tx, stay.id);
          const pdu = await buildInTx(tx, roomId, {
            type: 'm.room.member',
            state_key: target,
            sender,
            content,
            origin_server_ts: Date.now(),
          }, permit);
          // Local authorization precedes the remote side effect. The builder
          // signs bytes; it does not by itself authorize their membership change.
          const group = await tx.state.current(stay.id);
          const current = group === null
            ? new Map<string, string>()
            : await tx.state.groupMap(group);
          const evidence = await loadRulebookStore(tx, [...current.values()], [
            pdu,
          ]);
          const rulebook = getRulebook(version);
          const createId = current.get('m.room.create\0');
          if (
            !checkDeclaredAuth(
              pdu,
              rulebook,
              evidence,
              createId == null ? null : createId,
            ).ok || !rulebook.checkAuthAgainstState(pdu, current, evidence).ok
          ) {
            throw new MatrixError(
              403,
              'M_FORBIDDEN',
              'Remote invite is not authorized locally',
            );
          }
          return { version, pdu };
        })
      );
      const request = {
        room_version: version,
        event: toWire(pdu, version),
        invite_room_state: await prejoinState(room, sender),
      };
      saved = {
        roomId,
        sender,
        target,
        eventId: String(pdu.event_id),
        destination: remote,
        request,
        response: null,
        mayHaveApplied: false,
      };
      await deps.server.tx(async (tx) => {
        await admission?.check(tx);
        await withMembershipFence(admission, tx, async () => {
          if (replace) {
            const removed = await tx.execute(
              "DELETE FROM federation_invite_attempts WHERE event_id=? AND status='refused' AND may_have_applied=0",
              [String(rows[0].event_id)],
            );
            if (removed !== 1) {
              throw new MatrixError(
                409,
                'M_BAD_STATE',
                'Remote invite refusal changed',
              );
            }
          }
          await tx.execute(
            "INSERT INTO federation_invite_attempts(room_id,sender,target,event_id,destination,request_json,status,added_ms) VALUES(?,?,?,?,?,?,'pending',?)",
            [
              roomId,
              sender,
              target,
              saved.eventId,
              remote,
              JSON.stringify(request),
              Date.now(),
            ],
          );
        });
      });
    }
    if (invitePerformers(deps.store).has(saved.eventId)) {
      throw new MatrixError(409, 'M_BAD_STATE', 'Remote invite is active');
    }
    await deps.server.execute(
      "UPDATE federation_invite_attempts SET status='pending' WHERE event_id=? AND status IN ('failed','refused')",
      [saved.eventId],
    );
    invitePerformers(deps.store).add(saved.eventId);
    return saved;
  });
  try {
    return await performOutboundInvite(attempt, deps);
  } finally {
    invitePerformers(deps.store).delete(attempt.eventId);
    deps.wake(attempt.destination);
  }
}

async function performOutboundInvite(
  attempt: OutboundInvite,
  deps: InviteDeps,
): Promise<{ eventId: string }> {
  const { roomId, eventId, destination: remote, request } = attempt;
  const version = request.room_version;
  const pdu = { ...request.event, event_id: eventId } as unknown as Pdu;
  const room = await openRoom(deps.store, roomId);
  // A crash after ingest but before settlement never re-authors or re-publishes.
  const committed = await room.tx((tx) => tx.events.getStatus(eventId));
  if (
    committed?.standing === 'accepted' && committed.grounding === 'grounded'
  ) {
    await deps.server.execute(
      'DELETE FROM federation_invite_attempts WHERE event_id=?',
      [eventId],
    );
    return { eventId };
  }
  let refused = false;
  let priorUncertainty = true;
  try {
    let merged = attempt.response;
    if (merged === null) {
      const res = await federationRequest(deps.server, deps.signer, {
        room: { store: deps.store, id: roomId, participation: true },
        destination: remote,
        method: 'PUT',
        path: `/_matrix/federation/v2/invite/${encodeURIComponent(roomId)}/${
          encodeURIComponent(eventId)
        }`,
        body: new TextEncoder().encode(JSON.stringify(request)),
        beforeDispatch: async () => {
          await deps.server.tx(async (conn) => {
            const [row] = await conn.query(
              'SELECT may_have_applied FROM federation_invite_attempts WHERE event_id=?',
              [eventId],
            );
            if (!row) {
              throw new MatrixError(
                409,
                'M_BAD_STATE',
                'Remote invite was removed before dispatch',
              );
            }
            priorUncertainty = Boolean(row.may_have_applied);
            await conn.execute(
              'UPDATE federation_invite_attempts SET may_have_applied=1 WHERE event_id=?',
              [eventId],
            );
          });
        },
      }).catch((error: unknown) => {
        // Only a refusal of this submission proves non-acceptance. Key lookup
        // failures or invalid evidence after a response remain ambiguous.
        refused = isDefiniteFederationRefusal(error) && !priorUncertainty;
        throw error;
      });
      merged = inviteResponse(res.json);
    }
    // the invitee's signature: our id unchanged, their signature verifies
    const returnedId = await eventIdFor(
      merged as unknown as Record<string, unknown>,
      version,
    );
    merged.event_id = eventId;
    if (
      returnedId !== eventId || eventMaterial(merged) !== eventMaterial(pdu)
    ) {
      throw new UpstreamError('validation', {
        phase: 'invite',
        reason: 'the invitee changed the event',
      });
    }
    let theirSigOk = false;
    const mergedSigs = merged.signatures == null ? {} : merged.signatures;
    const remoteKids = mergedSigs[remote] == null ? {} : mergedSigs[remote];
    for (const kid of Object.keys(remoteKids)) {
      if (
        await deps.keys.verifyEventSignature({
          server: remote,
          keyId: kid,
          pdu: merged,
          roomVersion: version,
          minValidUntilMs: 0,
        })
      ) {
        theirSigOk = true;
        break;
      }
    }
    if (!theirSigOk) {
      throw new UpstreamError('validation', {
        phase: 'invite',
        reason: 'bad invitee signature',
      });
    }
    (merged as unknown as Record<string, unknown>).event_id = eventId;
    // merge signatures (ours is already on the event — author signed it)
    const ours = pdu.signatures == null ? {} : pdu.signatures;
    for (const [server, signatures] of Object.entries(ours)) {
      merged.signatures[server] = {
        ...merged.signatures[server],
        ...signatures,
      };
    }
    const retained = await deps.server.execute(
      'UPDATE federation_invite_attempts SET response_json=? WHERE event_id=?',
      [JSON.stringify(merged), eventId],
    );
    if (retained !== 1) {
      throw new MatrixError(
        409,
        'M_BAD_STATE',
        'Remote invite was removed during dispatch',
      );
    }
    // ingest as our own (we authored it — the strict local checks apply),
    // so outbox rows go to the room's servers as for any local event; the
    // invitee's server receives it only if it already has joined members
    // (invites-v2.yaml:40-42)
    const ingested = await ingestLocal(room, merged, deps.self, async (tx) => {
      await assertAcl(tx, remote);
      await assertAcl(tx, deps.self);
    });
    if (ingested.standing !== 'accepted') {
      await deps.server.execute(
        "UPDATE federation_invite_attempts SET status='failed' WHERE event_id=?",
        [eventId],
      );
      throw new MatrixError(
        403,
        'M_FORBIDDEN',
        'Remote invite no longer authorized locally',
      );
    }
    await deps.server.execute(
      'DELETE FROM federation_invite_attempts WHERE event_id=?',
      [eventId],
    );
    return { eventId };
  } catch (e) {
    // Both outcomes remain inspectable without autonomous retry. Only an exact
    // submission refusal allows a fresh, newly authorized event with new content.
    if (
      (e instanceof FederationHttpError && e.remoteStatus < 500) ||
      (e instanceof UpstreamError && e.category === 'validation')
    ) {
      await deps.server.execute(
        'UPDATE federation_invite_attempts SET status=?,may_have_applied=CASE WHEN ?=1 THEN 0 ELSE may_have_applied END WHERE event_id=?',
        [refused ? 'refused' : 'failed', refused ? 1 : 0, eventId],
      );
    }
    if (
      e instanceof FederationHttpError && e.remoteStatus === 400 &&
      e.matrixBody && e.errcode === 'M_MISSING_PARAM'
    ) {
      throw new MatrixError(502, 'M_UNKNOWN', String(e.responseBody().error));
    }
    throw e;
  }
}

// --- INVITEE ---------------------------------------------------------------

export type StoredInvite = PrejoinWork;
export const inviteOf = prejoinWorkOf;

export async function inviteFor(
  roomId: string,
  userId: string,
  deps: InviteDeps,
): Promise<StoredInvite | null> {
  const snapshot = await prejoinSnapshot(roomId, userId, deps);
  return snapshot.visible ? snapshot.row : null;
}

// Revision ownership is independent of display authority. Capture both in one
// read so a hidden row still fences late network completions and new attempts.
export async function prejoinSnapshot(
  roomId: string,
  userId: string,
  deps: InviteDeps,
): Promise<{ row: StoredInvite | null; visible: boolean }> {
  const rows = await deps.server.query(
    `SELECT *, (${
      visiblePrejoin('p')
    }) AS visible FROM prejoin_memberships p WHERE room_id = ? AND user_id = ?`,
    [roomId, userId],
  );
  return {
    row: rows.length === 0 ? null : inviteOf(rows[0]),
    visible: rows.length !== 0 && Number(rows[0].visible) === 1,
  };
}

// Every pending invite of a user (stage 5's /sync invite section).
export async function invitesOf(
  userId: string,
  deps: Pick<InviteDeps, 'server'>,
): Promise<StoredInvite[]> {
  const rows = await deps.server.query(
    `SELECT * FROM prejoin_memberships p WHERE user_id = ? AND ${
      visiblePrejoin('p')
    } ORDER BY received_ms`,
    [userId],
  );
  return rows.map(inviteOf);
}

// Do we participate in the room (a room file with an open stay)?
async function participating(
  deps: InviteDeps,
  roomId: string,
): Promise<boolean> {
  let room: Room;
  try {
    room = await openRoom(deps.store, roomId);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
    if (!deps.prepareRoomScope) return false;
    try {
      await deps.prepareRoomScope(roomId);
    } catch (error) {
      if (error instanceof MatrixError && error.status === 404) return false;
      throw error;
    }
    throw new MatrixError(503, 'M_UNAVAILABLE', 'room replica unavailable');
  }
  return await room.tx(async (tx) => (await tx.segments.openStay()) !== null);
}

// PUT /v2/invite/#roomId/#eventId (invites-v2.yaml:21-192)
export async function receiveInvite(
  roomId: string,
  eventId: string,
  raw: unknown,
  origin: string,
  deps: InviteDeps,
): Promise<Record<string, unknown>> {
  const operation = canonicalJson([origin, 'invite', roomId, eventId]);
  // Keep new-work ACL ordering, but completed authenticated work remains
  // replayable after a later ACL change, departure or room removal.
  const completed = (await deps.server.query(
    'SELECT 1 FROM membership_operations WHERE operation=?',
    [operation],
  )).length !== 0;
  let admission = completed
    ? undefined
    : await deps.prepareRoomScope?.(roomId, true);
  if (!completed) await assertRoomAcl(deps.store, roomId, origin);
  const body = (raw == null ? {} : raw) as {
    room_version?: unknown;
    event?: unknown;
    invite_room_state?: unknown;
  };
  const roomVersion = typeof body.room_version === 'string'
    ? body.room_version
    : null;
  if (roomVersion === null || !supportedRoomVersions().includes(roomVersion)) {
    throw new MatrixError(
      400,
      'M_INCOMPATIBLE_ROOM_VERSION',
      `unsupported room version ${String(body.room_version)}`,
      {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error: `unsupported room version ${String(body.room_version)}`,
        room_version: supportedRoomVersions().at(-1),
      },
    );
  }
  const pdu = body.event as Pdu | undefined;
  if (pdu === undefined) {
    throw new MatrixError(400, 'M_BAD_JSON', 'event is required');
  }
  // validation (invites-v2.yaml:157-169)
  if (
    pdu.type !== 'm.room.member' ||
    ((pdu.content == null ? {} : pdu.content) as { membership?: unknown })
        .membership !== 'invite'
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'expected an m.room.member invite',
    );
  }
  const target = String(pdu.state_key == null ? '' : pdu.state_key);
  if (!target.endsWith(':' + deps.self)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'state_key is not a local user');
  }
  if (!completed) {
    admission = await deps.prepareRoomScope?.(roomId, true, target);
  }
  if (domainOf(String(pdu.sender)) !== origin) {
    throw new MatrixError(400, 'M_BAD_JSON', 'sender is not the origin');
  }
  if (pdu.room_id !== roomId) {
    throw new MatrixError(400, 'M_BAD_JSON', 'room_id does not match the path');
  }
  const computed = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    roomVersion,
  );
  if (computed !== eventId) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'event id does not match the path',
    );
  }
  // the origin's signature must verify (the resolver strips the id —
  // their signature covers the wire form)
  let sigOk = false;
  const inviteSigs = pdu.signatures == null ? {} : pdu.signatures;
  const originKids = inviteSigs[origin] == null ? {} : inviteSigs[origin];
  for (const kid of Object.keys(originKids)) {
    if (
      await deps.keys.verifyEventSignature({
        server: origin,
        keyId: kid,
        pdu,
        roomVersion,
        minValidUntilMs: Date.now(),
      })
    ) {
      sigOk = true;
      break;
    }
  }
  if (!sigOk) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'bad signature');
  }
  (pdu as unknown as Record<string, unknown>).event_id = eventId;
  const inputHash = createHash('sha256').update(canonicalJson([
    roomVersion,
    eventMaterial(pdu),
  ])).digest('hex');
  const retained = await prejoinResult(deps.server, operation, inputHash);
  if (retained !== null) return retained;
  if (admission === undefined) {
    admission = await deps.prepareRoomScope?.(roomId, true, target);
  }
  if (admission) await deps.server.tx(admission.check);
  // Full create validation is shared with knocks. Legacy malformed hints are
  // filtered; v12 identity is strict. TODO Admin UI: compatibility warning.
  const stripped = await validatePrejoin(
    body.invite_room_state == null ? [] : body.invite_room_state,
    roomId,
    roomVersion,
    deps.keys,
  );
  // countersign and answer
  const prepared = await verify(pdu, roomVersion, deps.keys, { roomId }).catch(
    (error) => {
      if (!recoverableUpstream(error)) throw error;
      throw new MatrixError(403, 'M_FORBIDDEN', String(error));
    },
  );
  const signed = prepared.pdu;
  const permit = await prepareSigner(deps.signer);
  await countersign(signed, roomVersion, permit);
  admission?.checkCurrent();
  const response = { event: toWire(signed, roomVersion) };
  // store: a room we HOLD does nothing else (the event arrives by /send
  // too, invites-v2.yaml:40-42); otherwise the out-of-band row so the
  // invitee sees it
  return await withRoomLock(roomId, () =>
    withProjectionLock(async () => {
      const retained = await prejoinResult(deps.server, operation, inputHash);
      if (retained !== null) return retained;
      if (admission) await deps.server.tx(admission.check);
      await assertRoomAcl(deps.store, roomId, origin);
      if (await deps.store.roomRetired(roomId)) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'room removal is pending');
      }
      if (await participating(deps, roomId)) {
        return await deps.server.tx(async (tx) => {
          await admission?.check(tx);
          const result = await savePrejoinResult(
            tx,
            operation,
            roomId,
            inputHash,
            response,
          );
          admission?.checkCurrent();
          return result;
        });
      }
      const publication = await prepareInvitePush(
        deps.store,
        deps.self,
        signed,
      );
      const now = Date.now();
      return await eventStreamTx(deps.server, async (tx) => {
        await admission?.check(tx);
        const finish = async () => {
          const result = await savePrejoinResult(
            tx,
            operation,
            roomId,
            inputHash,
            response,
          );
          admission?.checkCurrent();
          return result;
        };
        const evaluated = await tx.query(
          'SELECT 1 FROM push_evaluations WHERE tenant=? AND user=? AND event=?',
          [deps.self, target, eventId],
        );
        if (evaluated.length) return await finish();
        const previous = await tx.query(
          'SELECT event_id FROM prejoin_memberships WHERE room_id=? AND user_id=?',
          [roomId, target],
        );
        // Redelivery is not a new invitation, including after local rejection.
        if (previous[0]?.event_id === eventId) return await finish();
        if (permit.admit) tx.admit(permit.admit);
        await recordMembershipOperation(tx, roomId, target);
        if (previous.length) {
          await withdrawInvitePush(
            tx,
            target,
            roomId,
            String(previous[0].event_id),
          );
        }
        const seq = await nextEventSeq(tx);
        await tx.execute(
          `INSERT INTO prejoin_memberships(room_id, user_id, event_id, room_version, event_json, invite_room_state, origin, received_ms, status, seq)
       VALUES(?,?,?,?,?,?,?,?,'pending',?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET event_id = excluded.event_id,
         room_version = excluded.room_version, event_json = excluded.event_json,
         invite_room_state = excluded.invite_room_state, origin = excluded.origin,
           received_ms = excluded.received_ms, status = 'pending', seq = excluded.seq,
            kind='invite', revision=prejoin_memberships.revision+1, candidates='[]', leave_json=NULL, local_leave_json=NULL, expires_ms=NULL`,
          [
            roomId,
            target,
            eventId,
            roomVersion,
            JSON.stringify(signed),
            JSON.stringify(stripped),
            origin,
            now,
            seq,
          ],
        );
        await applyInvitePush(tx, roomId, eventId, seq, publication, now);
        await recordMembershipOperation(tx, roomId, target);
        await supersedePrejoinKnocks(tx, roomId, target);
        return await finish();
      });
    }));
}

// --- REJECT (ruling F) -----------------------------------------------------

// The candidates of an invite row: the inviter first, then any server
// named in the stripped state (tuwunel's candidate set,
// leave.rs:255-345) — deterministic from the durable row.
export function candidatesOf(invite: StoredInvite, self: string): string[] {
  const stripped = JSON.parse(invite.inviteRoomState) as Record<
    string,
    unknown
  >[];
  const candidates = [...new Set([invite.origin, ...invite.candidates])];
  for (const e of stripped) {
    const sender = typeof e.sender === 'string' ? e.sender : null;
    if (sender === null) continue;
    const d = domainOf(sender);
    if (d !== self && !candidates.includes(d)) candidates.push(d);
  }
  return candidates;
}

// POST /rooms/#roomId/leave on a federation_invites room: local effect
// at once (the display goes 'rejecting'). The same transaction retains the
// exact independent local job; the sender's loop performs the dance.
export async function rejectInviteRemote(
  roomId: string,
  userId: string,
  deps: Pick<
    InviteDeps,
    'store' | 'server' | 'signer' | 'self' | 'wake' | 'prepareRoomScope'
  >,
  reason?: string,
): Promise<void> {
  const candidates = await withProjectionLock(async () => {
    // The request signer reads durable server authority. Capture it before the
    // server transaction, only when this lifecycle still needs a new departure.
    // Prepared departures remain replayable without renewing signing authority.
    if (await deps.store.roomRetired(roomId)) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'room removal is pending');
    }
    const snapshot = await deps.server.query(
      'SELECT status FROM prejoin_memberships WHERE room_id=? AND user_id=?',
      [roomId, userId],
    );
    const fresh = snapshot.length &&
      !['joined', 'rejecting', 'rejected', 'failed-retract'].includes(
        String(snapshot[0].status),
      );
    const admission = fresh
      ? await deps.prepareRoomScope?.(roomId, true, userId)
      : undefined;
    const prepared = fresh ? await prepareSigner(deps.signer) : null;
    return await eventStreamTx(deps.server, async (tx) => {
      if (await deps.store.roomRetired(roomId)) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'room removal is pending');
      }
      const rows = await tx.query(
        'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
        [roomId, userId],
      );
      const invite = rows.length === 0 ? null : inviteOf(rows[0]);
      if (invite === null || invite.status === 'joined') {
        throw new MatrixError(404, 'M_NOT_FOUND', 'no invite to reject');
      }
      // Client retries and durable account cleanup share this transition owner.
      // Never replace a prepared departure or restart its remote intent/revision.
      if (['rejecting', 'rejected', 'failed-retract'].includes(invite.status)) {
        return invite.status === 'rejecting'
          ? candidatesOf(invite, deps.self)
          : [];
      }
      if (prepared === null) {
        throw new MatrixError(
          409,
          'M_BAD_STATE',
          'membership changed during rejection',
        );
      }
      if (prepared.admit) tx.admit(prepared.admit);
      await admission?.check(tx);
      return await withMembershipFence(admission, tx, async () => {
        await recordMembershipOperation(tx, roomId, userId);
        await withdrawInvitePush(tx, userId, roomId, invite.eventId);
        const localLeave = await buildLocalPrejoinLeave(
          invite,
          prepared,
          reason,
        );
        const seq = await nextEventSeq(tx);
        await tx.execute(
          "UPDATE prejoin_memberships SET status = 'rejecting', revision=revision+1, leave_json=NULL, local_leave_json=?, seq = ?, expires_ms=CASE WHEN kind='knock' THEN ? ELSE NULL END WHERE room_id = ? AND user_id = ?",
          [
            JSON.stringify(localLeave),
            seq,
            Date.now() + config().federation.refusedmillihours * 3600,
            roomId,
            userId,
          ],
        );
        await recordMembershipOperation(tx, roomId, userId);
        const [pending] = await tx.query(
          'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
          [roomId, userId],
        );
        await createPrejoinJob(tx, inviteOf(pending));
        return candidatesOf(invite, deps.self);
      });
    });
  });
  // nothing ingested an event — wake the first candidate's loop directly
  if (candidates.length) deps.wake(candidates[0]);
}

// A local OOB departure is a real signed membership, not an edited invite or
// a stripped hint with an invented identity. Federation's make_leave result
// remains separate and may later replace this client notification.
async function buildLocalPrejoinLeave(
  invite: StoredInvite,
  signer: InviteDeps['signer'],
  reason?: string,
) {
  const previous = JSON.parse(invite.eventJson) as Pdu;
  return await finalizeBuilt(
    {
      type: 'm.room.member',
      room_id: invite.roomId,
      state_key: invite.userId,
      sender: invite.userId,
      content: {
        membership: 'leave',
        ...(reason === undefined ? {} : { reason }),
      },
      prev_events: [previous.event_id!],
      auth_events: [
        ...new Set([
          ...(previous.auth_events == null ? [] : previous.auth_events),
          previous.event_id!,
        ]),
      ],
      depth: previous.depth + 1,
      origin_server_ts: Date.now(),
      hashes: { sha256: '' },
      signatures: {},
    },
    getRulebook(invite.roomVersion),
    signer,
  );
}

export async function prejoinDeparture(
  invite: StoredInvite,
  deps: Pick<InviteDeps, 'server' | 'signer'>,
): Promise<Pdu | null> {
  const event = JSON.parse(invite.eventJson) as Pdu;
  if (
    event.content?.membership === 'leave' || event.content?.membership === 'ban'
  ) return event;
  if (invite.localLeaveJson !== null) {
    return JSON.parse(invite.localLeaveJson) as Pdu;
  }
  // Existing installations may have a pending intent without a local event.
  // Materialize once under the same revision owner; never synthesize per read.
  return await withProjectionLock(async () => {
    const snapshot = await deps.server.query(
      'SELECT local_leave_json FROM prejoin_memberships WHERE room_id=? AND user_id=? AND revision=? AND seq=?',
      [invite.roomId, invite.userId, invite.revision, invite.seq],
    );
    if (snapshot.length === 0) return null;
    if (snapshot[0].local_leave_json != null) {
      return JSON.parse(String(snapshot[0].local_leave_json)) as Pdu;
    }
    const prepared = await prepareSigner(deps.signer);
    return await deps.server.tx(async (tx) => {
      const rows = await tx.query(
        'SELECT local_leave_json FROM prejoin_memberships WHERE room_id=? AND user_id=? AND revision=? AND seq=?',
        [invite.roomId, invite.userId, invite.revision, invite.seq],
      );
      if (rows.length === 0) return null;
      if (rows[0]?.local_leave_json != null) {
        return JSON.parse(String(rows[0].local_leave_json)) as Pdu;
      }
      await recordMembershipOperation(tx, invite.roomId, invite.userId);
      if (prepared.admit) tx.admit(prepared.admit);
      const signed = await buildLocalPrejoinLeave(invite, prepared);
      await tx.execute(
        'UPDATE prejoin_memberships SET local_leave_json=? WHERE room_id=? AND user_id=? AND revision=? AND seq=?',
        [
          JSON.stringify(signed),
          invite.roomId,
          invite.userId,
          invite.revision,
          invite.seq,
        ],
      );
      await recordMembershipOperation(tx, invite.roomId, invite.userId);
      return signed;
    });
  });
}

// The reject-invite performer (ruling F): make_leave → fill → sign →
// send_leave v2 (→ v1 on endpoint-unknown) against the CURRENT
// destination; the loop advances candidates on failure.
export async function prepareRemoteLeave(
  destination: string,
  invite:
    & Pick<StoredInvite, 'userId' | 'roomId' | 'roomVersion'>
    & Partial<Pick<StoredInvite, 'localLeaveJson'>>,
  deps: Pick<InviteDeps, 'server' | 'signer' | 'store'>,
): Promise<Pdu> {
  const userId = invite.userId;
  const roomId = invite.roomId;
  const mk = await federationRequest(deps.server, deps.signer, {
    room: { store: deps.store, id: roomId },
    destination,
    method: 'GET',
    path: `/_matrix/federation/v1/make_leave/${encodeURIComponent(roomId)}/${
      encodeURIComponent(userId)
    }`,
    body: null,
  });
  const roomVersion = invite.roomVersion;
  // Only our durable departure carries the user's reason. A remote template
  // cannot substitute its content, and a retry keeps the same frozen leave.
  const reason = invite.localLeaveJson == null
    ? undefined
    : (JSON.parse(invite.localLeaveJson) as Pdu).content.reason;
  if (reason !== undefined && typeof reason !== 'string') {
    throw new Error('invalid stored prejoin departure reason');
  }
  const { event: template } = membershipTemplate(mk.json, 'make-leave', [
    roomVersion,
  ]);
  if (
    template.type !== 'm.room.member' || template.room_id !== roomId ||
    template.sender !== userId || template.state_key !== userId ||
    template.content.membership !== 'leave'
  ) {
    throw new UpstreamError('validation', {
      phase: 'make-leave',
      reason: 'invalid leave template identity',
    });
  }
  const pdu: Pdu = {
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    room_id: roomId,
    content: {
      membership: 'leave',
      ...(reason === undefined ? {} : { reason }),
    },
    prev_events: template.prev_events,
    auth_events: template.auth_events,
    depth: template.depth,
    origin_server_ts: Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  // hash, id and our signature (the old signPdu dance)
  return await finalizeBuilt(
    pdu,
    getRulebook(roomVersion),
    deps.signer,
  );
}

export async function sendRemoteLeave(
  destination: string,
  signed: Pdu,
  roomVersion: string,
  deps: Pick<InviteDeps, 'server' | 'signer' | 'store'>,
): Promise<void> {
  const roomId = String(signed.room_id);
  const eventId = String(signed.event_id);
  try {
    const response = await federationRequest(deps.server, deps.signer, {
      room: { store: deps.store, id: roomId },
      destination,
      method: 'PUT',
      path: `/_matrix/federation/v2/send_leave/${encodeURIComponent(roomId)}/${
        encodeURIComponent(eventId)
      }`,
      body: new TextEncoder().encode(
        JSON.stringify(toWire(signed, roomVersion)),
      ),
    });
    leaveResponse(response.json);
  } catch (e) {
    if (!isEndpointUnknown(e)) throw e;
    const response = await federationRequest(deps.server, deps.signer, {
      room: { store: deps.store, id: roomId },
      destination,
      method: 'PUT',
      path: `/_matrix/federation/v1/send_leave/${encodeURIComponent(roomId)}/${
        encodeURIComponent(eventId)
      }`,
      body: new TextEncoder().encode(
        JSON.stringify(toWire(signed, roomVersion)),
      ),
    });
    leaveResponse(response.json, true);
  }
}

async function performRejectInvite(
  destination: string,
  job: PrejoinJob,
  deps: InviteDeps,
): Promise<void> {
  const invite = job.work;
  const releaseJob = beginPrejoinJob(deps.store, invite);
  if (releaseJob === null) return;
  const release = beginPrejoinLeave(deps.store, invite.roomId, invite.userId);
  try {
    const prepared = invite.leaveJson === null
      ? await prepareSigner(deps.signer)
      : null;
    const signed = invite.leaveJson === null
      ? await prepareRemoteLeave(destination, invite, {
        ...deps,
        signer: prepared!,
      })
      : JSON.parse(invite.leaveJson) as Pdu;
    const active = await inviteTransition(deps.server, async (tx) => {
      if (prepared?.admit) tx.admit(prepared.admit);
      return await updatePrejoinJob(tx, job, {
        ...invite,
        leaveJson: JSON.stringify(signed),
      }, false);
    });
    if (!active) return;
    await sendRemoteLeave(destination, signed, invite.roomVersion, deps);
    // delivered: the row becomes 'rejected', and the SIGNED LEAVE becomes
    // the rendered event — the out-of-band leave section of /sync carries
    // it in state.events (stage 5; SyncLeftFrom wants a leave event there)
    await inviteTransition(deps.server, async (tx) => {
      await updatePrejoinJob(tx, active, {
        ...active.work,
        status: 'rejected',
        eventJson: JSON.stringify(signed),
      }, true);
    });
  } finally {
    release();
    releaseJob();
  }
}

// The sender's intent provider reads local jobs, never imported display rows.
// The current candidate index is in-memory (a restart resumes
// from the inviter). One job per destination per wake.
export function inviteIntentProvider(
  deps: InviteDeps,
): ReviewableIntentProvider {
  const progress: InviteProgress = new Map();
  const provider = async (server: Db, destination: string) => {
    const outgoing = await server.query(
      "SELECT * FROM federation_invite_attempts WHERE destination=? AND status='pending' ORDER BY added_ms,event_id",
      [destination],
    );
    for (const row of outgoing) {
      const attempt = outboundInvite(row);
      if (
        invitePerformers(deps.store).has(attempt.eventId) ||
        await deps.store.roomRetired(attempt.roomId)
      ) continue;
      return {
        id: 'invite:' + attempt.eventId,
        run: async () => {
          const claimed = await withRoomLock(attempt.roomId, async () => {
            if (
              await deps.store.roomRetired(attempt.roomId) ||
              invitePerformers(deps.store).has(attempt.eventId)
            ) return null;
            const [current] = await server.query(
              "SELECT * FROM federation_invite_attempts WHERE event_id=? AND status='pending'",
              [attempt.eventId],
            );
            if (!current) return null;
            invitePerformers(deps.store).add(attempt.eventId);
            return outboundInvite(current);
          });
          if (!claimed) return;
          try {
            await admit(server, destination, {
              kind: 'outbound',
              user: claimed.sender,
              what: 'intent:invite',
            });
            await performOutboundInvite(claimed, deps);
          } finally {
            invitePerformers(deps.store).delete(attempt.eventId);
          }
        },
        failed: async () => {},
      } satisfies IntentJob;
    }
    for (const pending of await prejoinJobs(server)) {
      if (prejoinJobActive(deps.store, pending.work)) continue;
      if (
        !prejoinLeaveActive(
          deps.store,
          pending.work.roomId,
          pending.work.userId,
        )
      ) {
        await inviteTransition(
          server,
          (tx) =>
            settleSupersededPrejoin(
              tx,
              pending.work.roomId,
              pending.work.userId,
            ),
        );
      }
      const job = await prejoinJob(server, pending.id);
      if (!job || !['rejecting', 'attempting'].includes(job.work.status)) {
        continue;
      }
      const invite = job.work;
      if (await deps.store.roomRetired(invite.roomId)) continue;
      if (invite.expiresMs !== null && Date.now() >= invite.expiresMs) {
        await inviteTransition(
          server,
          async (tx) => {
            return await updatePrejoinJob(
              tx,
              job,
              {
                ...invite,
                status: invite.status === 'attempting'
                  ? 'failed-attempt'
                  : 'failed-retract',
              },
              true,
              false,
            );
          },
        );
        continue;
      }
      if (invite.status === 'attempting') {
        if (invite.origin !== destination) continue;
        return {
          id: 'knock-attempt:' + job.id,
          run: async () => {
            await performKnockAttempt(invite, deps);
          },
          failed: async () => {},
        } satisfies IntentJob;
      }
      const key = job.id;
      const candidates = candidatesOf(invite, deps.self);
      const at = candidateIndex(invite, progress);
      if (candidates[at] !== destination) continue;
      return {
        id: 'reject-invite:' + key,
        run: async () => {
          const active = await withProjectionLock(async () => {
            if (await deps.store.roomRetired(invite.roomId)) return false;
            const current = await prejoinJob(server, job.id);
            return current?.work.revision === invite.revision &&
              current.work.status === 'rejecting' &&
              candidateIndex(current.work, progress) === at;
          });
          if (!active) return;
          await admit(server, destination, {
            kind: 'outbound',
            user: invite.userId,
            what: 'intent:reject-invite',
          });
          await performRejectInvite(destination, job, deps);
          progress.delete(key);
        },
        failed: () =>
          withProjectionLock(async () => {
            if (await deps.store.roomRetired(invite.roomId)) return;
            const current = (await prejoinJob(server, job.id))?.work;
            if (
              current?.eventId !== invite.eventId ||
              current.revision !== invite.revision ||
              current.status !== 'rejecting' ||
              candidateIndex(current, progress) !== at
            ) return;
            const next = candidates.length === 0
              ? null
              : candidates[(at + 1) % candidates.length];
            if (next !== null) {
              progress.set(key, {
                eventId: invite.eventId,
                at: (at + 1) % candidates.length,
              });
              if (next !== destination) deps.wake(next);
            }
          }),
      } satisfies IntentJob;
    }
    return null;
  };
  return Object.assign(provider, {
    review: () => listRejectIntents(deps.server, deps.self, progress),
    prune: (destination: string) =>
      pruneRejectIntents(deps.server, deps.self, destination, progress),
  });
}

type InviteProgress = Map<string, { eventId: string; at: number }>;

function candidateIndex(
  invite: StoredInvite,
  progress: InviteProgress,
): number {
  const entry = progress.get(prejoinJobId(invite));
  return entry?.eventId === invite.eventId ? entry.at : 0;
}

/** Operator review shares candidate ownership with the performing provider. */
export async function listRejectIntents(
  server: Pick<Db, 'query'>,
  self: string,
  progress: InviteProgress = new Map(),
): Promise<ReviewIntent[]> {
  const jobs = await prejoinJobs(server);
  const outgoing = await server.query(
    'SELECT * FROM federation_invite_attempts ORDER BY added_ms,event_id',
  );
  const invites: ReviewIntent[] = outgoing.map((row) => ({
    id: 'invite:' + String(row.event_id),
    destination: String(row.destination),
    kind: 'intent',
    eventId: null,
    intent: {
      what: 'invite',
      user_id: String(row.sender),
      candidates: [String(row.destination)],
    },
    addedMs: Number(row.added_ms),
    expiresMs: null,
    inflightTxn: null,
  }));
  return [
    ...invites,
    ...jobs.map((job) => {
      const invite = job.work;
      const key = job.id;
      const candidates = candidatesOf(invite, self);
      const at = candidateIndex(invite, progress);
      return {
        id:
          (invite.status === 'attempting' || invite.status === 'failed-attempt'
            ? 'knock-attempt:'
            : 'reject-invite:') + key,
        destination: candidates[at],
        kind: 'intent' as const,
        eventId: null,
        intent: {
          what: invite.kind === 'invite'
            ? 'reject-invite'
            : invite.status.includes('attempt')
            ? 'knock-attempt'
            : 'retract-knock',
          user_id: invite.userId,
          candidates,
        },
        addedMs: invite.receivedMs,
        expiresMs: invite.expiresMs,
        inflightTxn: null,
      };
    }),
  ];
}

export async function pruneRejectIntents(
  server: Db,
  self: string,
  destination: string,
  progress: InviteProgress = new Map(),
): Promise<number> {
  return await inviteTransition(server, async (tx) => {
    const rows = (await listRejectIntents(tx, self, progress)).filter((r) =>
      r.destination === destination
    );
    let count = 0;
    for (const row of rows) {
      if (row.id.startsWith('invite:')) {
        count += await tx.execute(
          'DELETE FROM federation_invite_attempts WHERE event_id=?',
          [row.id.slice('invite:'.length)],
        );
        continue;
      }
      if (row.id.startsWith('knock-attempt:')) {
        const job = await prejoinJob(tx, row.id.slice('knock-attempt:'.length));
        if (!job) continue;
        // An ambiguous remote side effect cannot be discarded by prune. Turn
        // it into explicit compensating leave work, visible locally at once.
        count += Number(
          await retractPrejoinKnock(
            tx,
            job,
            Date.now() + config().federation.refusedmillihours * 3600,
          ),
        );
        continue;
      }
      const key = row.id.slice('reject-invite:'.length);
      const job = await prejoinJob(tx, key);
      if (!job) continue;
      count += Number(
        (await updatePrejoinJob(tx, job, {
          ...job.work,
          status: 'rejected',
          revision: job.work.revision + 1,
        }, true)) !== null,
      );
      progress.delete(key);
    }
    return count;
  });
}

export async function retryPrejoinIntents(
  server: Db,
  self: string,
  destination: string,
): Promise<void> {
  await inviteTransition(server, async (tx) => {
    await tx.execute(
      "UPDATE federation_invite_attempts SET status='pending' WHERE destination=? AND status IN ('failed','refused')",
      [destination],
    );
    const rows = await listRejectIntents(tx, self);
    for (const row of rows) {
      if (row.id.startsWith('invite:')) continue;
      if (!row.intent.candidates.includes(destination)) continue;
      const prefix = row.id.startsWith('knock-attempt:')
        ? 'knock-attempt:'
        : 'reject-invite:';
      const job = await prejoinJob(tx, row.id.slice(prefix.length));
      if (
        !job || !['failed-attempt', 'failed-retract'].includes(job.work.status)
      ) continue;
      await updatePrejoinJob(
        tx,
        job,
        {
          ...job.work,
          status: job.work.status === 'failed-attempt'
            ? 'attempting'
            : 'rejecting',
          revision: job.work.revision + 1,
          expiresMs: Date.now() + config().federation.refusedmillihours * 3600,
        },
        true,
        false,
      );
    }
  });
}

// --- RESCIND (§3.8 step 7) --------------------------------------------------

// An m.room.member leave/ban for a user with a federation_invites row,
// sent by the original inviter, is a remote rejection (tuwunel's
// handle_incoming_pdu.rs:296-299 — a powerful third party's kick does
// not rescind). Row 'rejected', no room file.
export async function acceptRescind(
  roomId: string,
  pdu: Pdu,
  deps: InviteDeps,
): Promise<boolean> {
  if (pdu.type !== 'm.room.member') return false;
  const membership = ((pdu.content == null ? {} : pdu.content) as {
    membership?: unknown;
  }).membership;
  if (membership !== 'leave' && membership !== 'ban') return false;
  const target = String(pdu.state_key == null ? '' : pdu.state_key);
  const sender = String(pdu.sender == null ? '' : pdu.sender);
  return await inviteTransition(deps.server, async (tx) => {
    const rows = await tx.query(
      'SELECT * FROM prejoin_memberships WHERE room_id=? AND user_id=?',
      [roomId, target],
    );
    const invite = rows.length === 0 ? null : inviteOf(rows[0]);
    if (
      invite === null || invite.kind !== 'invite' || invite.status === 'joined'
    ) return false;
    const stored = JSON.parse(invite.eventJson) as Record<string, unknown>;
    const inviter = typeof stored.sender === 'string' ? stored.sender : null;
    if (inviter === null || sender !== inviter) return false;
    await recordMembershipOperation(tx, roomId, target);
    await withdrawInvitePush(tx, target, roomId, invite.eventId);
    const seq = await nextEventSeq(tx);
    await tx.execute(
      "UPDATE prejoin_memberships SET status = 'rejected', revision=revision+1, event_json = ?, seq = ? WHERE room_id = ? AND user_id = ?",
      [
        JSON.stringify(pdu as unknown as Record<string, unknown>),
        seq,
        roomId,
        target,
      ],
    );
    await recordMembershipOperation(tx, roomId, target);
    return true;
  });
}

// --- join ↔ invite wiring ----------------------------------------------------

// §3.6 step 2: the via list for accepting an invite over federation —
// the inviter first, then any server named in the stripped state. Empty
// when no invite is held.
export async function inviteJoinCandidates(
  roomId: string,
  userId: string,
  deps: InviteDeps,
): Promise<string[]> {
  const invite = await inviteFor(roomId, userId, deps);
  if (
    invite === null || invite.kind !== 'invite' || invite.status !== 'pending'
  ) return [];
  return candidatesOf(invite, deps.self);
}

// §3.6 step 2: the inviter's server is a candidate when we hold a
// pending invite; accepting marks the row 'joined'.
export async function markInviteJoined(
  roomId: string,
  userId: string,
  deps: InviteDeps,
): Promise<void> {
  await inviteTransition(deps.server, async (tx) => {
    const rows = await tx.query(
      "SELECT event_id FROM prejoin_memberships WHERE room_id = ? AND user_id = ? AND status IN ('pending','attempting')",
      [roomId, userId],
    );
    if (rows.length === 0) return;
    await recordMembershipOperation(tx, roomId, userId);
    await withdrawInvitePush(tx, userId, roomId, String(rows[0].event_id));
    const seq = await nextEventSeq(tx);
    await tx.execute(
      "UPDATE prejoin_memberships SET status = 'joined', revision=revision+1, seq = ? WHERE room_id = ? AND user_id = ? AND status IN ('pending','attempting')",
      [seq, roomId, userId],
    );
    await recordMembershipOperation(tx, roomId, userId);
  });
}
