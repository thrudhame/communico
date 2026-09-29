// api/engine/federation/invites.ts — invites both ways (§3.8).
//
// INVITER (a local user invites @x:remote): admit → author → PUT
// /v2/invite with the stripped invite_room_state → merge the invitee's
// signature → ingest as our own (we authored it — the strict local
// checks apply; r6, gemini). The whole exchange is synchronous inside
// the CS request.
//
// INVITEE (PUT /v2/invite): validate, sign, answer { event }; a room we
// do not hold stores a federation_invites row + a room_membership row
// (no room DB is provisioned for an invite) so /sync notices.
//
// REJECT (ruling F): local effect at once (the user sees the invite
// gone / the room as left) + a 'reject-invite' INTENT row in the outbox
// in one server-DB transaction — the make_leave/send_leave dance is
// retried on the ladder against the inviter first, then any server
// named in the stripped state. No silent local-only fallback.
//
// RESCIND: an m.room.member leave/ban for a user with a
// federation_invites row, from the inviter or a sender with power in
// the stripped state, is a remote rejection (tuwunel is the only prior
// art, handle_incoming_pdu.rs:125-133 — the code comment says so).
import { serverName } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { supportedRoomVersions } from '#engine/policy.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { signPdu, verifyPduSignature } from '#engine/signing.ts';
import { getVerifyKey } from './keys.ts';
import { admit } from './gate.ts';
import { federationRequest } from './client.ts';
import { domainOf, toWire } from './pdu.ts';
import { writeRows } from './outbox.ts';
import { registerIntentPerformer, wakeDestination } from './sender.ts';
import { lookupRoom, serversInRoom, stateAtSeq } from '#engine/room.ts';
import type { Pdu } from '#engine/pdu.ts';

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
  roomId: string,
  inviter: string,
): Promise<Record<string, unknown>[]> {
  const currentRows = await stateAtSeq(roomId, null);
  const rows = currentRows == null ? [] : currentRows;
  const out: Record<string, unknown>[] = [];
  for (const r of rows) {
    const isInviterMember = r.type === 'm.room.member' &&
      r.stateKey === inviter;
    if (!isInviterMember && !STRIPPED_TYPES.has(r.type)) continue;
    const entry: Record<string, unknown> = {
      type: r.type,
      state_key: r.stateKey,
      content: r.content,
      sender: r.eventId === undefined
        ? undefined
        : await senderOf(roomId, r.eventId),
    };
    if (r.type === 'm.room.create') {
      entry.origin_server_ts = await tsOf(roomId, r.eventId);
    }
    out.push(entry);
  }
  return out;
}

async function senderOf(roomId: string, eventId: string): Promise<string> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return '';
    const room = await lookupRoom(roomId);
    if (room === null) return '';
    return await withDb(room.dbName, async (rc) => {
      const rr = await rc.query(
        `SELECT sender FROM events AS OF '${
          String(r.rows[0].commit_hash)
        }' WHERE event_id = $1;`,
        [eventId],
      );
      return rr.rows.length === 0 ? '' : String(rr.rows[0].sender);
    });
  });
}

async function tsOf(roomId: string, eventId: string): Promise<number> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
      [roomId, eventId],
    );
    if (r.rows.length === 0) return 0;
    const room = await lookupRoom(roomId);
    if (room === null) return 0;
    return await withDb(room.dbName, async (rc) => {
      const rr = await rc.query(
        `SELECT origin_ts FROM events AS OF '${
          String(r.rows[0].commit_hash)
        }' WHERE event_id = $1;`,
        [eventId],
      );
      return rr.rows.length === 0 ? 0 : Number(rr.rows[0].origin_ts);
    });
  });
}

// --- INVITER ---------------------------------------------------------------

export async function inviteRemote(
  roomId: string,
  sender: string,
  target: string,
  reason?: string,
): Promise<{ eventId: string }> {
  const remote = domainOf(target);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  // roster growth by intent (closed mode → 403 to the client, pending row)
  await admit(remote, { kind: 'outbound', user: sender, what: 'invite' });
  // author the invite event (our signature), outside the room lock —
  // commit-hash branching makes a stale prev harmless
  const content: Record<string, unknown> = { membership: 'invite' };
  if (reason !== undefined) content.reason = reason;
  const pdu = await author(roomId, {
    type: 'm.room.member',
    state_key: target,
    sender,
    content,
    origin_server_ts: Date.now(),
  });
  const eventId = String(pdu.event_id);
  const inviteRoomState = await strippedState(roomId, sender);
  let resp: Record<string, unknown>;
  try {
    const res = await federationRequest({
      destination: remote,
      method: 'PUT',
      path: `/_matrix/federation/v2/invite/${encodeURIComponent(roomId)}/${
        encodeURIComponent(eventId)
      }`,
      body: new TextEncoder().encode(
        JSON.stringify({
          room_version: room.roomVersion,
          event: toWire(pdu, room.roomVersion),
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
    room.roomVersion,
  );
  if (returnedId !== eventId) {
    throw new MatrixError(502, 'M_UNKNOWN', 'the invitee changed the event');
  }
  // their signature covers the form they received — the wire form, NO
  // event_id — so verify BEFORE restoring it
  let theirSigOk = false;
  const mergedSigs = merged.signatures == null ? {} : merged.signatures;
  const remoteKids = mergedSigs[remote] == null ? {} : mergedSigs[remote];
  for (const kid of Object.keys(remoteKids)) {
    try {
      const key = await getVerifyKey(remote, kid, 0, 'event', { roomId });
      if (
        await verifyPduSignature(merged, key, remote, kid, room.roomVersion)
      ) {
        theirSigOk = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!theirSigOk) {
    throw new MatrixError(502, 'M_UNKNOWN', 'bad invitee signature');
  }
  (merged as unknown as Record<string, unknown>).event_id = eventId;
  // merge signatures (ours is already on the event — author signed it)
  const ours = (pdu.signatures == null ? {} : pdu.signatures) as Record<
    string,
    Record<string, string>
  >;
  merged.signatures = {
    ...(merged.signatures == null ? {} : merged.signatures),
    ...ours,
  } as Record<string, Record<string, string>>;
  // ingest as our own (we authored it — the strict local checks apply),
  // so outbox rows go to the room's servers as for any local event; the
  // invitee's server receives it only if it already has joined members
  // (invites-v2.yaml:40-42)
  await ingestEvent(roomId, merged);
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
  status: string;
};

export async function inviteFor(
  roomId: string,
  userId: string,
): Promise<StoredInvite | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      'SELECT * FROM federation_invites WHERE room_id = $1 AND user_id = $2;',
      [roomId, userId],
    );
    if (r.rows.length === 0) return null;
    const o = r.rows[0] as Record<string, unknown>;
    return {
      roomId: String(o.room_id),
      userId: String(o.user_id),
      eventId: String(o.event_id),
      roomVersion: String(o.room_version),
      eventJson: String(o.event_json),
      inviteRoomState: String(o.invite_room_state),
      origin: String(o.origin),
      status: String(o.status),
    };
  });
}

// PUT /v2/invite/#roomId/#eventId (invites-v2.yaml:21-192)
export async function receiveInvite(
  roomId: string,
  eventId: string,
  raw: unknown,
  origin: string,
): Promise<Record<string, unknown>> {
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
  if (!target.endsWith(':' + serverName())) {
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
  (pdu as unknown as Record<string, unknown>).event_id = eventId;
  // the origin's signature must verify
  let sigOk = false;
  const inviteSigs = pdu.signatures == null ? {} : pdu.signatures;
  const originKids = inviteSigs[origin] == null ? {} : inviteSigs[origin];
  for (const kid of Object.keys(originKids)) {
    try {
      const key = await getVerifyKey(origin, kid, Date.now(), 'request');
      if (await verifyPduSignature(pdu, key, origin, kid, roomVersion)) {
        sigOk = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!sigOk) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'bad signature');
  }
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
  // sign and answer
  const key = await getTenantKey();
  await signPdu(pdu, roomVersion, key);
  // store: a room we HOLD does nothing else (the event arrives by /send
  // too, invites-v2.yaml:40-42); otherwise the out-of-band row +
  // membership row so /sync notices
  const held = await lookupRoom(roomId);
  const weAreIn = held !== null &&
    (await serversInRoom(roomId)).includes(serverName());
  if (!weAreIn) {
    await withDb(serverDb(), async (c) => {
      await c.query(
        `INSERT INTO federation_invites (room_id, user_id, event_id, room_version, event_json, invite_room_state, origin, received_ms, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
         ON CONFLICT (room_id, user_id) DO UPDATE SET event_id = $3, room_version = $4, event_json = $5, invite_room_state = $6, origin = $7, received_ms = $8, status = 'pending';`,
        [
          roomId,
          target,
          eventId,
          roomVersion,
          JSON.stringify(pdu),
          JSON.stringify(stripped),
          origin,
          Date.now(),
        ],
      );
      await c.query(
        `INSERT INTO room_membership (room_id, user_id, membership, event_id, seq)
         VALUES ($1, $2, 'invite', $3, nextval('event_seq'))
         ON CONFLICT (room_id, user_id) DO UPDATE SET membership = 'invite', event_id = $3, seq = nextval('event_seq');`,
        [roomId, target, eventId],
      );
    });
  }
  return { event: toWire(pdu, roomVersion) };
}

// --- REJECT (ruling F) -----------------------------------------------------

// POST /rooms/#roomId/leave on a federation_invites room: local effect
// at once + the intent row in ONE server-DB transaction.
export async function rejectInviteRemote(
  roomId: string,
  userId: string,
): Promise<void> {
  const invite = await inviteFor(roomId, userId);
  if (invite === null || invite.status === 'joined') {
    throw new MatrixError(404, 'M_NOT_FOUND', 'no invite to reject');
  }
  // candidates: the inviter first, then any server named in the stripped
  // state (tuwunel's candidate set, leave.rs:255-345)
  const stripped = JSON.parse(invite.inviteRoomState) as Record<
    string,
    unknown
  >[];
  const candidates = [invite.origin];
  for (const e of stripped) {
    const sender = typeof e.sender === 'string' ? e.sender : null;
    if (sender === null) continue;
    const d = domainOf(sender);
    if (d !== serverName() && !candidates.includes(d)) candidates.push(d);
  }
  await withDb(serverDb(), async (c) => {
    await c.query('BEGIN;');
    try {
      // local effect at once: the rooms.leave section shows it
      await c.query(
        `UPDATE federation_invites SET status = 'rejecting' WHERE room_id = $1 AND user_id = $2;`,
        [roomId, userId],
      );
      await c.query(
        `INSERT INTO room_membership (room_id, user_id, membership, event_id, seq)
         VALUES ($1, $2, 'leave', $3, nextval('event_seq'))
         ON CONFLICT (room_id, user_id) DO UPDATE SET membership = 'leave', event_id = $3, seq = nextval('event_seq');`,
        [roomId, userId, invite.eventId],
      );
      // the delivery obligation: an intent row for the first candidate
      await writeRows(c, [{
        destination: candidates[0],
        roomId,
        kind: 'intent',
        intent: {
          what: 'reject-invite',
          user_id: userId,
          candidates,
        },
      }]);
      await c.query('COMMIT;');
    } catch (e) {
      await c.query('ROLLBACK;');
      throw e;
    }
  });
  // nothing ingested an event — wake the first candidate's loop directly
  wakeDestination(candidates[0]);
}

// the reject-invite performer (ruling F): make_leave → fill → sign →
// send_leave v2 (→ v1 on endpoint-unknown) against the CURRENT
// destination; the loop advances candidates on failure
async function performRejectInvite(
  destination: string,
  intent: Record<string, unknown>,
): Promise<void> {
  const userId = String(intent.user_id == null ? '' : intent.user_id);
  const invite = await inviteForByUser(userId);
  if (invite === null) return; // nothing to reject (already joined?)
  const roomId = invite.roomId;
  const mk = await federationRequest({
    destination,
    method: 'GET',
    path: `/_matrix/federation/v1/make_leave/${encodeURIComponent(roomId)}/${
      encodeURIComponent(userId)
    }`,
    body: null,
  });
  const template = mk.json as Record<string, unknown>;
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
  const key = await getTenantKey();
  await signPdu(pdu, roomVersion, key);
  const eventId = String(pdu.event_id);
  try {
    await federationRequest({
      destination,
      method: 'PUT',
      path: `/_matrix/federation/v2/send_leave/${encodeURIComponent(roomId)}/${
        encodeURIComponent(eventId)
      }`,
      body: new TextEncoder().encode(
        JSON.stringify(toWire(pdu, roomVersion)),
      ),
    });
  } catch (e) {
    const err = e as { status?: number; errcode?: string };
    const endpointUnknown = (err.status === 404 || err.status === 405) &&
      (err.errcode === undefined || err.errcode === 'M_UNRECOGNIZED');
    if (!endpointUnknown) throw e;
    await federationRequest({
      destination,
      method: 'PUT',
      path: `/_matrix/federation/v1/send_leave/${encodeURIComponent(roomId)}/${
        encodeURIComponent(eventId)
      }`,
      body: new TextEncoder().encode(
        JSON.stringify(toWire(pdu, roomVersion)),
      ),
    });
  }
  // delivered: the row becomes 'rejected'
  await withDb(serverDb(), async (c) => {
    await c.query(
      `UPDATE federation_invites SET status = 'rejected' WHERE room_id = $1 AND user_id = $2;`,
      [roomId, userId],
    );
  });
}

async function inviteForByUser(userId: string): Promise<StoredInvite | null> {
  return await withDb(serverDb(), async (c) => {
    const r = await c.query(
      `SELECT * FROM federation_invites WHERE user_id = $1 AND status IN ('pending', 'rejecting')
       ORDER BY received_ms DESC LIMIT 1;`,
      [userId],
    );
    if (r.rows.length === 0) return null;
    const o = r.rows[0] as Record<string, unknown>;
    return {
      roomId: String(o.room_id),
      userId: String(o.user_id),
      eventId: String(o.event_id),
      roomVersion: String(o.room_version),
      eventJson: String(o.event_json),
      inviteRoomState: String(o.invite_room_state),
      origin: String(o.origin),
      status: String(o.status),
    };
  });
}

/** Registered with commit 3's performer registry by startSender. */
export function registerRejectInvitePerformer(): void {
  registerIntentPerformer('reject-invite', performRejectInvite);
}

// --- RESCIND (§3.8 step 7) --------------------------------------------------

// An m.room.member leave/ban for a user with a federation_invites row,
// sent by the inviter or a sender with power in the stripped state, is a
// remote rejection (tuwunel is the only prior art,
// handle_incoming_pdu.rs:125-133). Row 'rejected', membership 'leave',
// no room DB.
export async function acceptRescind(
  roomId: string,
  pdu: Pdu,
): Promise<boolean> {
  if (pdu.type !== 'm.room.member') return false;
  const membership = ((pdu.content == null ? {} : pdu.content) as {
    membership?: unknown;
  }).membership;
  if (membership !== 'leave' && membership !== 'ban') return false;
  const target = String(pdu.state_key == null ? '' : pdu.state_key);
  const invite = await inviteFor(roomId, target);
  if (invite === null || invite.status === 'joined') return false;
  const sender = String(pdu.sender == null ? '' : pdu.sender);
  let allowed: boolean;
  if (domainOf(sender) === invite.origin) {
    allowed = true;
  } else {
    // a sender with power in the stripped state (PL > 0 there)
    const stripped = JSON.parse(invite.inviteRoomState) as Record<
      string,
      unknown
    >[];
    const pl = stripped.find((e) => e.type === 'm.room.power_levels');
    const plUsers = ((pl == null || pl.content == null ? {} : pl.content) as {
      users?: Record<string, number>;
    }).users;
    const users = plUsers == null ? {} : plUsers;
    const senderPower = users[sender] == null ? 0 : users[sender];
    allowed = senderPower > 0;
  }
  if (!allowed) return false;
  await withDb(serverDb(), async (c) => {
    await c.query(
      `UPDATE federation_invites SET status = 'rejected' WHERE room_id = $1 AND user_id = $2;`,
      [roomId, target],
    );
    await c.query(
      `INSERT INTO room_membership (room_id, user_id, membership, event_id, seq)
       VALUES ($1, $2, 'leave', $3, nextval('event_seq'))
       ON CONFLICT (room_id, user_id) DO UPDATE SET membership = 'leave', event_id = $3, seq = nextval('event_seq');`,
      [roomId, target, String(pdu.event_id)],
    );
  });
  return true;
}

// --- join ↔ invite wiring ----------------------------------------------------

// §3.6 step 2: the inviter's server is a candidate when we hold a
// pending invite; accepting marks the row 'joined'.
export async function markInviteJoined(
  roomId: string,
  userId: string,
): Promise<void> {
  await withDb(serverDb(), async (c) => {
    await c.query(
      `UPDATE federation_invites SET status = 'joined' WHERE room_id = $1 AND user_id = $2 AND status = 'pending';`,
      [roomId, userId],
    );
  });
}
