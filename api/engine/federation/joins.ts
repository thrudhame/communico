// api/engine/federation/joins.ts — serving joins and leaves (§3.5, the
// RESIDENT role). make_* builds the template (author()'s partial,
// unsigned); send_* validates the remote's signed event, adds OUR
// signature (SS:881-885 — the spec's wording is unconditional; tuwunel
// always, Synapse only restricted), ingests it on the origin's behalf,
// and answers with the snapshot taken BEFORE the ingest. Served PDUs
// everywhere are wire form (pdu.ts toWire). The ACL hook point rides in
// each handler (M5c).
import { serverName } from '#engine/config.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { domainOf, toWire } from './pdu.ts';
import { lookupRoom, serverInRoom, stateAtSeq } from '#engine/room.ts';
import { authChain } from '#engine/rulebook/state-res-v2.ts';
import { eventIdFor } from '#engine/eventid.ts';
import { getTenantKey } from '#engine/tenant.ts';
import { signPdu, verifyPduSignature } from '#engine/signing.ts';
import { getVerifyKey } from './keys.ts';
import type { Pdu } from '#engine/pdu.ts';

function aclCheck(roomId: string, origin: string): void {
  void roomId;
  void origin; // M5c: server ACLs (SS:1236-1279)
}

async function statePdus(
  roomId: string,
): Promise<{ pdus: Record<string, unknown>[]; byId: Map<string, Pdu> }> {
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  const rows = (await stateAtSeq(roomId, null)) ?? [];
  const byId = new Map<string, Pdu>();
  await withDb(room.dbName, async (c) => {
    for (const row of rows) {
      const commit = await withDb(serverDb(), async (s) => {
        const r = await s.query(
          'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
          [roomId, row.eventId],
        );
        return r.rows.length ? String(r.rows[0].commit_hash) : null;
      });
      if (commit === null) continue;
      const r = await c.query(
        `SELECT canonical_json FROM events AS OF '${commit}' WHERE event_id = $1;`,
        [row.eventId],
      );
      if (r.rows.length === 0) continue;
      const pdu = (typeof r.rows[0].canonical_json === 'string'
        ? JSON.parse(String(r.rows[0].canonical_json))
        : r.rows[0].canonical_json) as Pdu;
      byId.set(row.eventId, pdu);
    }
  });
  return {
    pdus: [...byId.values()].map((p) => toWire(p, room.roomVersion)),
    byId,
  };
}

async function joinTemplate(
  roomId: string,
  userId: string,
  membership: 'join' | 'leave',
  origin: string,
  ver: string[],
): Promise<Record<string, unknown>> {
  aclCheck(roomId, origin);
  if (domainOf(userId) !== origin) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      `${userId} is not on ${origin}`,
    );
  }
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  if (!ver.includes(room.roomVersion)) {
    throw new MatrixError(
      400,
      'M_INCOMPATIBLE_ROOM_VERSION',
      `This server does not know how to join a room of version ${room.roomVersion}`,
      {
        errcode: 'M_INCOMPATIBLE_ROOM_VERSION',
        error:
          `This server does not know how to join a room of version ${room.roomVersion}`,
        room_version: room.roomVersion,
      },
    );
  }
  // the user must not be banned; under invite-only rules they need an
  // invite; restricted is M5c (400 M_UNABLE_TO_AUTHORISE_JOIN)
  const state = (await stateAtSeq(roomId, null)) ?? [];
  const jr = state.find((r) => r.type === 'm.room.join_rules');
  const joinRule = ((jr?.content ?? {}) as { join_rule?: unknown }).join_rule;
  if (joinRule === 'restricted') {
    throw new MatrixError(
      400,
      'M_UNABLE_TO_AUTHORISE_JOIN',
      'restricted rooms are M5c',
    );
  }
  const memberRow = state.find((r) =>
    r.type === 'm.room.member' && r.stateKey === userId
  );
  const current = ((memberRow?.content ?? {}) as { membership?: unknown })
    .membership;
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
  const pdu = await author(roomId, {
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    content: { membership },
    origin_server_ts: Date.now(),
  });
  // the template is the partial WITHOUT signing (joins-v1.yaml:130-153):
  // every field author() fills EXCEPT event_id, hashes, signatures,
  // unsigned; room_id rides even on v12 (only the create lacks it,
  // v12.md:96-109) — and `origin` names the resident
  return {
    type: 'm.room.member',
    state_key: userId,
    sender: userId,
    room_id: roomId,
    content: { membership },
    prev_events: pdu.prev_events ?? [],
    auth_events: pdu.auth_events ?? [],
    depth: Number(pdu.depth),
    origin: serverName(),
    origin_server_ts: Number(pdu.origin_server_ts),
  };
}

// GET /v1/make_join/#roomId/#userId?ver= (joins-v1.yaml:20-225;
// SS:866-885)
export async function makeJoin(
  roomId: string,
  userId: string,
  origin: string,
  ver: string[],
): Promise<Record<string, unknown>> {
  return await joinTemplate(roomId, userId, 'join', origin, ver);
}

// GET /v1/make_leave/#roomId/#userId (leaving-v1.yaml:20-140)
export async function makeLeave(
  roomId: string,
  userId: string,
  origin: string,
  ver: string[],
): Promise<Record<string, unknown>> {
  return await joinTemplate(roomId, userId, 'leave', origin, ver);
}

async function sendMembership(
  roomId: string,
  eventId: string,
  raw: unknown,
  origin: string,
  membership: 'join' | 'leave',
  apiVersion: 'v1' | 'v2',
): Promise<Record<string, unknown> | [number, Record<string, unknown>]> {
  aclCheck(roomId, origin);
  const room = await lookupRoom(roomId);
  if (room === null) throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  if (!(await serverInRoom(roomId, serverName()))) {
    // a room WE left is a room we are not in (§3.6a): a non-member
    // cannot act as resident for anyone
    throw new MatrixError(404, 'M_NOT_FOUND', roomId);
  }
  const pdu = raw as Pdu;
  // validation (joins-v1.yaml:226-390 / leaving-v2.yaml:21-136;
  // Complement's testValidationForSendMembershipEndpoint:420+)
  if (pdu.room_id !== roomId) {
    throw new MatrixError(400, 'M_BAD_JSON', 'room_id does not match the path');
  }
  if (
    pdu.type !== 'm.room.member' || pdu.state_key !== pdu.sender ||
    ((pdu.content ?? {}) as { membership?: unknown }).membership !== membership
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
  const computed = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    room.roomVersion,
  );
  if (computed !== eventId) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'event id does not match the path',
    );
  }
  // the wire form has no event_id (v3+, transported out-of-band) — the
  // signature covers the redacted form WITH it, so restore it before
  // verifying and ingesting
  (pdu as unknown as Record<string, unknown>).event_id = eventId;
  // the origin's signature must verify
  const entries = Object.entries(pdu.signatures?.[origin] ?? {});
  let sigOk = false;
  for (const [kid] of entries) {
    try {
      const key = await getVerifyKey(origin, kid, Date.now(), 'request');
      if (
        await verifyPduSignature(pdu, key, origin, kid, room.roomVersion)
      ) {
        sigOk = true;
        break;
      }
    } catch { /* next key id */ }
  }
  if (!sigOk) {
    throw new MatrixError(403, 'M_FORBIDDEN', 'bad signature');
  }

  // the snapshot BEFORE the ingest: state + the auth chains of those
  // events and of the join
  const { pdus: state, byId } = await statePdus(roomId);
  const store = {
    get: (id: string) => byId.get(id),
    isRejected: () => false,
  };
  const chainIds = new Set<string>([
    ...authChain([...byId.keys()], store),
    ...authChain([eventId], store),
  ]);
  const auth_chain: Record<string, unknown>[] = [];
  for (const id of chainIds) {
    const p = byId.get(id);
    if (p !== undefined) auth_chain.push(toWire(p, room.roomVersion));
  }

  // our signature on the remote's event (SS:881-885), then ingest on
  // behalf of the origin (outbox rows exclude it — the resident fans out)
  const key = await getTenantKey();
  await signPdu(pdu, room.roomVersion, key);
  try {
    await ingestEvent(roomId, pdu, {
      remote: { origin, onBehalfOf: true, position: 'after' },
    });
  } catch (e) {
    const msg = String(e);
    if (msg.includes('M_STATE_REJECT') || msg.includes('M_AUTHCHAIN_REJECT')) {
      throw new MatrixError(403, 'M_FORBIDDEN', msg);
    }
    throw e;
  }

  if (membership === 'leave') {
    return apiVersion === 'v2' ? {} : [200, {}];
  }
  const event = toWire(pdu, room.roomVersion);
  if (apiVersion === 'v2') {
    // omit_members accepted and ignored (joins-v2.yaml:59-77 — optional;
    // members_omitted:false is then the truthful answer)
    return {
      state,
      auth_chain,
      event,
      members_omitted: false,
      servers_in_room: [serverName()],
    };
  }
  return [200, { state, auth_chain, event }];
}

// PUT /v2/send_join/#roomId/#eventId and PUT /v1/send_join/...
export async function sendJoin(
  roomId: string,
  eventId: string,
  pdu: unknown,
  origin: string,
  apiVersion: 'v1' | 'v2',
): Promise<Record<string, unknown> | [number, Record<string, unknown>]> {
  return await sendMembership(roomId, eventId, pdu, origin, 'join', apiVersion);
}

// PUT /v2/send_leave/#roomId/#eventId and v1 (depth present but ignored,
// leaving-v1.yaml:214-217)
export async function sendLeave(
  roomId: string,
  eventId: string,
  pdu: unknown,
  origin: string,
  apiVersion: 'v1' | 'v2',
): Promise<Record<string, unknown> | [number, Record<string, unknown>]> {
  return await sendMembership(
    roomId,
    eventId,
    pdu,
    origin,
    'leave',
    apiVersion,
  );
}
