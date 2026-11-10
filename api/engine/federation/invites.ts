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
// the invite row (the 4b outbox has no intent kind); the candidate
// progress is in-memory — a restart resumes from the first candidate
// (the inviter, always a correct first retry).
//
// RESCIND: an m.room.member leave/ban for a user with a
// federation_invites row, from the inviter, is a remote rejection
// (tuwunel is the only prior art, handle_incoming_pdu.rs:125-133).
import { canonicalJson } from '#engine/canonical.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { buildInTx, finalizeBuilt, roomVersionOf } from '#engine/room/build.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import { ingestLocal } from '#engine/room/ingest.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import type { Signer } from '#engine/room/signer.ts';
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
import { federationRequest, isEndpointUnknown } from './client.ts';
import { assertRoomAcl } from './acl.ts';
import { assertAcl } from '#engine/room/acl.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { admit } from './gate.ts';
import { domainOf, toWire } from './pdu.ts';
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
const STRIPPED_TYPES = new Set([
  'm.room.create',
  'm.room.name',
  'm.room.avatar',
  'm.room.topic',
  'm.room.join_rules',
  'm.room.canonical_alias',
  'm.room.encryption',
]);

async function strippedState(
  room: Room,
  inviter: string,
): Promise<Record<string, unknown>[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) return [];
    const group = await tx.state.current(stay.id);
    if (group === null) return [];
    const map = await tx.state.groupMap(group);
    const out: Record<string, unknown>[] = [];
    for (const [key, eventId] of map) {
      const sep = key.indexOf('\0');
      const type = key.slice(0, sep);
      const stateKey = key.slice(sep + 1);
      const isInviterMember = type === 'm.room.member' && stateKey === inviter;
      if (!isInviterMember && !STRIPPED_TYPES.has(type)) continue;
      const row = await tx.events.get(eventId);
      if (row === null) continue;
      const pdu = JSON.parse(row.pdu) as Pdu;
      const entry: Record<string, unknown> = {
        type,
        state_key: stateKey,
        content: pdu.content,
        sender: pdu.sender,
      };
      if (type === 'm.room.create') {
        entry.origin_server_ts = pdu.origin_server_ts;
      }
      out.push(entry);
    }
    return out;
  });
}

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

export async function inviteRemote(
  roomId: string,
  sender: string,
  target: string,
  reason: string | undefined,
  opts: { isDirect?: boolean } | undefined,
  deps: InviteDeps,
): Promise<{ eventId: string }> {
  const remote = domainOf(target);
  const room = await openRoom(deps.store, roomId);
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
  // author the invite event (our signature), outside the room lock —
  // a stale prev is harmless (the resolver orders forks)
  const content: Record<string, unknown> = { membership: 'invite' };
  if (reason !== undefined) content.reason = reason;
  if (opts?.isDirect === true) content.is_direct = true;
  const version = await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    if (stay === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
    return await roomVersionOf(tx, stay.id);
  });
  const pdu = await room.tx((tx) =>
    buildInTx(tx, roomId, {
      type: 'm.room.member',
      state_key: target,
      sender,
      content,
      origin_server_ts: Date.now(),
    }, deps.signer)
  );
  const eventId = String(pdu.event_id);
  const inviteRoomState = await strippedState(room, sender);
  let resp: Record<string, unknown>;
  try {
    const res = await federationRequest(deps.server, deps.signer, {
      room: { store: deps.store, id: roomId, participation: true },
      destination: remote,
      method: 'PUT',
      path: `/_matrix/federation/v2/invite/${encodeURIComponent(roomId)}/${
        encodeURIComponent(eventId)
      }`,
      body: new TextEncoder().encode(
        JSON.stringify({
          room_version: version,
          event: toWire(pdu, version),
          invite_room_state: inviteRoomState,
        }),
      ),
    });
    resp = res.json as Record<string, unknown>;
  } catch (e) {
    const err = e as { status?: number; errcode?: string; message?: string };
    // only 400 M_MISSING_PARAM becomes a 5xx to our client
    // (invites-v2.yaml:171-173); network failure → 502
    if (err.status === 400 && err.errcode === 'M_MISSING_PARAM') {
      throw new MatrixError(
        502,
        'M_UNKNOWN',
        err.message == null ? 'M_MISSING_PARAM' : err.message,
      );
    }
    if (err.status === undefined) {
      throw new MatrixError(502, 'M_UNKNOWN', `network failure: ${String(e)}`);
    }
    throw e; // 403 M_FORBIDDEN and 400 M_INCOMPATIBLE_ROOM_VERSION pass through
  }
  // the invitee's signature: our id unchanged, their signature verifies
  const returned = resp.event as Record<string, unknown> | undefined;
  if (returned === undefined) {
    throw new MatrixError(502, 'M_UNKNOWN', 'no event in the invite answer');
  }
  const merged = returned as unknown as Pdu;
  const returnedId = await eventIdFor(
    merged as unknown as Record<string, unknown>,
    version,
  );
  if (returnedId !== eventId) {
    throw new MatrixError(502, 'M_UNKNOWN', 'the invitee changed the event');
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
    throw new MatrixError(502, 'M_UNKNOWN', 'bad invitee signature');
  }
  (merged as unknown as Record<string, unknown>).event_id = eventId;
  // merge signatures (ours is already on the event — author signed it)
  const ours = pdu.signatures == null ? {} : pdu.signatures;
  merged.signatures = {
    ...(merged.signatures == null ? {} : merged.signatures),
    ...ours,
  };
  // ingest as our own (we authored it — the strict local checks apply),
  // so outbox rows go to the room's servers as for any local event; the
  // invitee's server receives it only if it already has joined members
  // (invites-v2.yaml:40-42)
  await ingestLocal(room, merged, deps.self, async (tx) => {
    await assertAcl(tx, remote);
    await assertAcl(tx, deps.self);
  });
  return { eventId };
}

// --- INVITEE ---------------------------------------------------------------

export type StoredInvite = {
  roomId: string;
  userId: string;
  eventId: string;
  roomVersion: string;
  eventJson: string;
  inviteRoomState: string;
  origin: string;
  receivedMs: number;
  status: string;
  seq: number;
};

// deno-lint-ignore no-explicit-any
function inviteOf(row: any): StoredInvite {
  return {
    roomId: String(row.room_id),
    userId: String(row.user_id),
    eventId: String(row.event_id),
    roomVersion: String(row.room_version),
    eventJson: String(row.event_json),
    inviteRoomState: String(row.invite_room_state),
    origin: String(row.origin),
    receivedMs: Number(row.received_ms),
    status: String(row.status),
    seq: Number(row.seq),
  };
}

export async function inviteFor(
  roomId: string,
  userId: string,
  deps: InviteDeps,
): Promise<StoredInvite | null> {
  const rows = await deps.server.query(
    'SELECT * FROM federation_invites WHERE room_id = ? AND user_id = ?',
    [roomId, userId],
  );
  return rows.length === 0 ? null : inviteOf(rows[0]);
}

// Every pending invite of a user (stage 5's /sync invite section).
export async function invitesOf(
  userId: string,
  deps: InviteDeps,
): Promise<StoredInvite[]> {
  const rows = await deps.server.query(
    'SELECT * FROM federation_invites WHERE user_id = ? ORDER BY received_ms',
    [userId],
  );
  return rows.map(inviteOf);
}

// Do we participate in the room (a room file with an open stay)?
async function participating(store: Store, roomId: string): Promise<boolean> {
  let room: Room;
  try {
    room = await openRoom(store, roomId);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
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
  await assertRoomAcl(deps.store, roomId, origin);
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
  // invite_room_state, when present, contains a create event formatted
  // for the version (SS:949-957 — v1.16 says warn for ≤ v11, error for
  // others; we warn for all — the absent list is accepted, Complement
  // TestIsDirectFlagFederation sends [])
  const stripped = Array.isArray(body.invite_room_state)
    ? body.invite_room_state as Record<string, unknown>[]
    : [];
  if (stripped.length > 0) {
    const hasCreate = stripped.some((e) => e.type === 'm.room.create');
    if (!hasCreate) {
      console.warn(
        `federation: invite from ${origin} without a create in invite_room_state`,
      );
    }
  }
  // countersign and answer
  await countersign(pdu, roomVersion, deps.signer);
  // store: a room we HOLD does nothing else (the event arrives by /send
  // too, invites-v2.yaml:40-42); otherwise the out-of-band row so the
  // invitee sees it
  await withRoomLock(roomId, () =>
    withProjectionLock(async () => {
      await assertRoomAcl(deps.store, roomId, origin);
      if (await deps.store.roomRetired(roomId)) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'room removal is pending');
      }
      if (await participating(deps.store, roomId)) return;
      const publication = await prepareInvitePush(deps.store, deps.self, pdu);
      const now = Date.now();
      await eventStreamTx(deps.server, async (tx) => {
        const evaluated = await tx.query(
          'SELECT 1 FROM push_evaluations WHERE tenant=? AND user=? AND event=?',
          [deps.self, target, eventId],
        );
        if (evaluated.length) return;
        const previous = await tx.query(
          'SELECT event_id FROM federation_invites WHERE room_id=? AND user_id=?',
          [roomId, target],
        );
        // Redelivery is not a new invitation, including after local rejection.
        if (previous[0]?.event_id === eventId) return;
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
          `INSERT INTO federation_invites(room_id, user_id, event_id, room_version, event_json, invite_room_state, origin, received_ms, status, seq)
       VALUES(?,?,?,?,?,?,?,?,'pending',?)
       ON CONFLICT(room_id, user_id) DO UPDATE SET event_id = excluded.event_id,
         room_version = excluded.room_version, event_json = excluded.event_json,
         invite_room_state = excluded.invite_room_state, origin = excluded.origin,
          received_ms = excluded.received_ms, status = 'pending', seq = excluded.seq`,
          [
            roomId,
            target,
            eventId,
            roomVersion,
            JSON.stringify(pdu),
            JSON.stringify(stripped),
            origin,
            now,
            seq,
          ],
        );
        await applyInvitePush(tx, roomId, eventId, seq, publication, now);
      });
    }));
  return { event: toWire(pdu, roomVersion) };
}

// --- REJECT (ruling F) -----------------------------------------------------

// The candidates of an invite row: the inviter first, then any server
// named in the stripped state (tuwunel's candidate set,
// leave.rs:255-345) — deterministic from the durable row.
function candidatesOf(invite: StoredInvite, self: string): string[] {
  const stripped = JSON.parse(invite.inviteRoomState) as Record<
    string,
    unknown
  >[];
  const candidates = [invite.origin];
  for (const e of stripped) {
    const sender = typeof e.sender === 'string' ? e.sender : null;
    if (sender === null) continue;
    const d = domainOf(sender);
    if (d !== self && !candidates.includes(d)) candidates.push(d);
  }
  return candidates;
}

// POST /rooms/#roomId/leave on a federation_invites room: local effect
// at once (the row goes 'rejecting') — the intent itself is durable in
// the row; the sender's loop performs the dance.
export async function rejectInviteRemote(
  roomId: string,
  userId: string,
  deps: InviteDeps,
): Promise<void> {
  const candidates = await inviteTransition(deps.server, async (tx) => {
    if (await deps.store.roomRetired(roomId)) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'room removal is pending');
    }
    const rows = await tx.query(
      'SELECT * FROM federation_invites WHERE room_id=? AND user_id=?',
      [roomId, userId],
    );
    const invite = rows.length === 0 ? null : inviteOf(rows[0]);
    if (invite === null || invite.status === 'joined') {
      throw new MatrixError(404, 'M_NOT_FOUND', 'no invite to reject');
    }
    await withdrawInvitePush(tx, userId, roomId, invite.eventId);
    const seq = await nextEventSeq(tx);
    await tx.execute(
      "UPDATE federation_invites SET status = 'rejecting', seq = ? WHERE room_id = ? AND user_id = ?",
      [seq, roomId, userId],
    );
    return candidatesOf(invite, deps.self);
  });
  // nothing ingested an event — wake the first candidate's loop directly
  deps.wake(candidates[0]);
}

// The reject-invite performer (ruling F): make_leave → fill → sign →
// send_leave v2 (→ v1 on endpoint-unknown) against the CURRENT
// destination; the loop advances candidates on failure.
export async function prepareRemoteLeave(
  destination: string,
  invite: Pick<StoredInvite, 'userId' | 'roomId' | 'roomVersion'>,
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
  // the spec's wrapper (leaving-v1.yaml): room_version + event
  const mkBody = mk.json as { event?: unknown };
  const template = (mkBody.event == null ? {} : mkBody.event) as Record<
    string,
    unknown
  >;
  const roomVersion = invite.roomVersion;
  const pdu: Pdu = {
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    room_id: roomId,
    content: { membership: 'leave' },
    prev_events:
      (template.prev_events == null ? [] : template.prev_events) as string[],
    auth_events:
      (template.auth_events == null ? [] : template.auth_events) as string[],
    depth: Number(template.depth == null ? 1 : template.depth),
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
    await federationRequest(deps.server, deps.signer, {
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
  } catch (e) {
    if (!isEndpointUnknown(e)) throw e;
    await federationRequest(deps.server, deps.signer, {
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
  }
}

async function performRejectInvite(
  destination: string,
  invite: StoredInvite,
  deps: InviteDeps,
): Promise<void> {
  const signed = await prepareRemoteLeave(destination, invite, deps);
  await sendRemoteLeave(destination, signed, invite.roomVersion, deps);
  const { roomId, userId } = invite;
  // delivered: the row becomes 'rejected', and the SIGNED LEAVE becomes
  // the rendered event — the out-of-band leave section of /sync carries
  // it in state.events (stage 5; SyncLeftFrom wants a leave event there)
  await inviteTransition(deps.server, async (tx) => {
    const pending = await tx.query(
      "SELECT 1 FROM federation_invites WHERE room_id=? AND user_id=? AND event_id=? AND status='rejecting'",
      [roomId, userId, invite.eventId],
    );
    if (pending.length === 0) return;
    const seq = await nextEventSeq(tx);
    await tx.execute(
      "UPDATE federation_invites SET status = 'rejected', event_json = ?, seq = ? WHERE room_id = ? AND user_id = ?",
      [
        JSON.stringify(signed as unknown as Record<string, unknown>),
        seq,
        roomId,
        userId,
      ],
    );
  });
}

// The sender's intent provider: 'rejecting' invites are the durable
// intents; the current candidate index is in-memory (a restart resumes
// from the inviter). One job per destination per wake.
export function inviteIntentProvider(
  deps: InviteDeps,
): ReviewableIntentProvider {
  const progress: InviteProgress = new Map();
  const provider = async (server: Db, destination: string) => {
    const rows = await server.query(
      "SELECT * FROM federation_invites WHERE status = 'rejecting' ORDER BY received_ms",
      [],
    );
    for (const raw of rows) {
      const invite = inviteOf(raw);
      if (await deps.store.roomRetired(invite.roomId)) continue;
      const key = JSON.stringify([invite.roomId, invite.userId]);
      const candidates = candidatesOf(invite, deps.self);
      const at = candidateIndex(invite, progress);
      if (candidates[at] !== destination) continue;
      return {
        id: 'reject-invite:' + key,
        run: async () => {
          const active = await withProjectionLock(async () => {
            if (await deps.store.roomRetired(invite.roomId)) return false;
            const current = await inviteFor(invite.roomId, invite.userId, deps);
            return current?.eventId === invite.eventId &&
              current.status === 'rejecting' &&
              candidateIndex(current, progress) === at;
          });
          if (!active) return;
          await admit(server, destination, {
            kind: 'outbound',
            user: invite.userId,
            what: 'intent:reject-invite',
          });
          await performRejectInvite(destination, invite, deps);
          await withProjectionLock(async () => {
            const current = await inviteFor(invite.roomId, invite.userId, deps);
            if (current === null || current.eventId === invite.eventId) {
              progress.delete(key);
            }
          });
        },
        failed: () =>
          withProjectionLock(async () => {
            if (await deps.store.roomRetired(invite.roomId)) return;
            const current = await inviteFor(invite.roomId, invite.userId, deps);
            if (
              current?.eventId !== invite.eventId ||
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
  const entry = progress.get(JSON.stringify([invite.roomId, invite.userId]));
  return entry?.eventId === invite.eventId ? entry.at : 0;
}

/** Operator review shares candidate ownership with the performing provider. */
export async function listRejectIntents(
  server: Pick<Db, 'query'>,
  self: string,
  progress: InviteProgress = new Map(),
): Promise<ReviewIntent[]> {
  const rows = await server.query(
    "SELECT * FROM federation_invites WHERE status = 'rejecting' ORDER BY received_ms, room_id, user_id",
  );
  return rows.map((raw) => {
    const invite = inviteOf(raw);
    const key = JSON.stringify([invite.roomId, invite.userId]);
    const candidates = candidatesOf(invite, self);
    const at = candidateIndex(invite, progress);
    return {
      id: 'reject-invite:' + key,
      destination: candidates[at],
      kind: 'intent',
      eventId: null,
      intent: { what: 'reject-invite', user_id: invite.userId, candidates },
      addedMs: invite.receivedMs,
      expiresMs: null,
      inflightTxn: null,
    };
  });
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
      const key = row.id.slice('reject-invite:'.length);
      const [roomId, userId] = JSON.parse(key) as [string, string];
      count += await tx.execute(
        "UPDATE federation_invites SET status = 'rejected', seq = ? WHERE room_id = ? AND user_id = ? AND status = 'rejecting'",
        [await nextEventSeq(tx), roomId, userId],
      );
      progress.delete(key);
    }
    return count;
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
      'SELECT * FROM federation_invites WHERE room_id=? AND user_id=?',
      [roomId, target],
    );
    const invite = rows.length === 0 ? null : inviteOf(rows[0]);
    if (invite === null || invite.status === 'joined') return false;
    const stored = JSON.parse(invite.eventJson) as Record<string, unknown>;
    const inviter = typeof stored.sender === 'string' ? stored.sender : null;
    if (inviter === null || sender !== inviter) return false;
    await withdrawInvitePush(tx, target, roomId, invite.eventId);
    const seq = await nextEventSeq(tx);
    await tx.execute(
      "UPDATE federation_invites SET status = 'rejected', event_json = ?, seq = ? WHERE room_id = ? AND user_id = ?",
      [
        JSON.stringify(pdu as unknown as Record<string, unknown>),
        seq,
        roomId,
        target,
      ],
    );
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
  if (invite === null || invite.status !== 'pending') return [];
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
      "SELECT event_id FROM federation_invites WHERE room_id = ? AND user_id = ? AND status = 'pending'",
      [roomId, userId],
    );
    if (rows.length === 0) return;
    await withdrawInvitePush(tx, userId, roomId, String(rows[0].event_id));
    const seq = await nextEventSeq(tx);
    await tx.execute(
      "UPDATE federation_invites SET status = 'joined', seq = ? WHERE room_id = ? AND user_id = ? AND status = 'pending'",
      [seq, roomId, userId],
    );
  });
}
