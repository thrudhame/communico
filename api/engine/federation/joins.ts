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
  const currentRows = await stateAtSeq(roomId, null);
  const rows = currentRows == null ? [] : currentRows;
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
  const currentState = await stateAtSeq(roomId, null);
  const state = currentState == null ? [] : currentState;
  const jr = state.find((r) => r.type === 'm.room.join_rules');
  const joinRule = ((jr == null || jr.content == null ? {} : jr.content) as {
    join_rule?: unknown;
  }).join_rule;
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
  const current =
    ((memberRow == null || memberRow.content == null
      ? {}
      : memberRow.content) as { membership?: unknown }).membership;
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
  // the answer wraps the template (joins-v1.yaml:55-81, leaving-v1.yaml:
  // the same): { room_version, event } — the event is the partial
  // WITHOUT signing: every field author() fills EXCEPT event_id, hashes,
  // signatures, unsigned; room_id rides even on v12 (only the create
  // lacks it, v12.md:96-109) — and `origin` names the resident
  return {
    room_version: room.roomVersion,
    event: {
      type: 'm.room.member',
      state_key: userId,
      sender: userId,
      room_id: roomId,
      content: { membership },
      prev_events: pdu.prev_events == null ? [] : pdu.prev_events,
      auth_events: pdu.auth_events == null ? [] : pdu.auth_events,
      depth: Number(pdu.depth),
      origin: serverName(),
      origin_server_ts: Number(pdu.origin_server_ts),
    },
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
    ((pdu.content == null ? {} : pdu.content) as { membership?: unknown })
        .membership !== membership
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
  const originSigs = pdu.signatures == null ? {} : pdu.signatures;
  const entries = Object.entries(
    originSigs[origin] == null ? {} : originSigs[origin],
  );
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

// ---------------------------------------------------------------------------
// the JOINING role (§3.6) — joining a room on another server
// ---------------------------------------------------------------------------

import { admit } from './gate.ts';
import { federationRequest } from './client.ts';
import { allocateChapterPair, provisionRoom } from '#engine/room.ts';
import { ingestJoinSnapshotLocked, withRoomLock } from '#engine/ingest.ts';
import { checkRemoteFormat } from './pdu.ts';
import { contentHashOf } from '#engine/signing-primitives.js';
import { getProfile } from '#engine/tenant.ts';
import { localpartOf } from '#engine/auth.ts';
import { getRulebook, supportedRoomVersions } from '#engine/policy.ts';
import { redact } from '#engine/eventid.ts';
import type { StateRowInput } from '#engine/materialize.ts';

function isEndpointUnknown(e: unknown): boolean {
  // v2 → v1 fallback ONLY on endpoint-unknown answers (joins-v2.yaml:26-32):
  // 404/405 with M_UNRECOGNIZED or a non-Matrix body; a genuine remote
  // 400/403 with a Matrix body is the answer and is surfaced, not replayed
  const err = e as { status?: number; errcode?: string };
  if (err.status !== 404 && err.status !== 405) return false;
  return err.errcode === undefined || err.errcode === 'M_UNRECOGNIZED';
}

function isFailover(e: unknown): boolean {
  // fail over to the next candidate on network failure, 5xx,
  // 404 M_NOT_FOUND, M_UNABLE_TO_AUTHORISE_JOIN, M_UNABLE_TO_GRANT_JOIN
  // (Synapse federation_client.py:914-976; Complement
  // TestJoinFederatedRoomFailOver:95-140 pins 404 → next); abort on
  // other 4xx (403, M_INCOMPATIBLE_ROOM_VERSION)
  const err = e as { status?: number; errcode?: string };
  if (err.status === undefined) return true; // network/timeout
  if (err.status >= 500) return true;
  if (err.status === 404 && err.errcode === 'M_NOT_FOUND') return true;
  return err.errcode === 'M_UNABLE_TO_AUTHORISE_JOIN' ||
    err.errcode === 'M_UNABLE_TO_GRANT_JOIN';
}

type SnapshotEvent = { pdu: Pdu; eventId: string; rejected?: boolean };

// §3.6 step 7 — the snapshot checks: format; hash (redact on mismatch);
// signature of the sender's server (witnesses include the room's servers
// — the snapshot's member domains — and the resident); unverifiable →
// omitted from the batch (TestJoinFederatedRoomWithUnverifiableEvents);
// exactly one create with room_version = the template's; auth rules 1–2
// against the snapshot's own auth chain, topologically (rejected →
// stored with 'auth').
async function checkSnapshot(
  roomId: string,
  roomVersion: string,
  state: Record<string, unknown>[],
  authChain: Record<string, unknown>[],
  resident: string,
  joinEventId: string,
): Promise<{ events: SnapshotEvent[]; stateRows: StateRowInput[] }> {
  const spec = getRulebook(roomVersion).spec;
  const events: SnapshotEvent[] = [];
  const byId = new Map<string, Pdu>();
  const seen = new Set<string>();
  for (const raw of [...state, ...authChain]) {
    const pdu = raw as unknown as Pdu;
    // the same event rides both state and auth_chain — once is enough
    const preId = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      roomVersion,
    ).catch(() => null);
    if (preId !== null && seen.has(preId)) continue;
    if (preId !== null) seen.add(preId);
    // format first (a format failure drops the event from the batch)
    try {
      checkRemoteFormat(pdu, spec, { exemptPrevAuthLimits: false });
    } catch {
      continue;
    }
    // the wire form has no event_id — compute it
    const eventId = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      roomVersion,
    );
    (pdu as unknown as Record<string, unknown>).event_id = eventId;
    // hash: mismatch → the redacted copy (SS:1328-1336)
    const { event_id: _a, ...noId } = pdu as unknown as Record<string, unknown>;
    void _a;
    const hashOk = (await contentHashOf(noId)) === pdu.hashes?.sha256;
    if (!hashOk) {
      const redacted = redact(
        pdu as unknown as Record<string, unknown>,
        roomVersion,
      );
      for (const k of Object.keys(pdu)) {
        delete (pdu as unknown as Record<string, unknown>)[k];
      }
      Object.assign(pdu, redacted);
    }
    // signature of the SENDER'S server (witnesses include the room's
    // servers and the resident)
    const senderDomain = domainOf(String(pdu.sender));
    const senderSigsAll = pdu.signatures == null ? {} : pdu.signatures;
    const senderSigs = senderSigsAll[senderDomain] == null
      ? {}
      : senderSigsAll[senderDomain];
    let sigOk = false;
    if (senderDomain === serverName()) {
      // our own event in the snapshot (a re-join's carries it) — verify
      // with the tenant key, never a self-dial
      const key = await getTenantKey();
      for (const kid of Object.keys(senderSigs)) {
        if (
          await verifyPduSignature(
            pdu,
            key.publicKey,
            senderDomain,
            kid,
            roomVersion,
          )
        ) {
          sigOk = true;
          break;
        }
      }
    }
    if (!sigOk) {
      for (const kid of Object.keys(senderSigs)) {
        try {
          const key = await getVerifyKey(
            senderDomain,
            kid,
            spec.enforceKeyValidity ? Number(pdu.origin_server_ts) : 0,
            'event',
            { roomId },
          );
          if (
            await verifyPduSignature(pdu, key, senderDomain, kid, roomVersion)
          ) {
            sigOk = true;
            break;
          }
        } catch { /* try the next key id */ }
      }
    }
    // the resident's signature also vouches (it signs the snapshot's
    // events when forwarding)
    if (!sigOk) {
      const residentSigs = pdu.signatures == null ? {} : pdu.signatures;
      const residentKids = residentSigs[resident] == null
        ? {}
        : residentSigs[resident];
      for (const kid of Object.keys(residentKids)) {
        try {
          const key = await getVerifyKey(resident, kid, 0, 'event', {
            roomId,
          });
          if (
            await verifyPduSignature(pdu, key, resident, kid, roomVersion)
          ) {
            sigOk = true;
            break;
          }
        } catch { /* next */ }
      }
    }
    if (!sigOk) continue; // unverifiable → omitted from the batch
    byId.set(eventId, pdu);
    // the joining event is in the snapshot's state (the resident
    // accepted it before answering) but is NOT a root event — step 9
    // gives it its own treatment (its live index row would collide with
    // the evidence row)
    if (eventId === joinEventId) continue;
    events.push({ pdu, eventId });
  }
  // exactly one create, with room_version = the template's
  const creates = events.filter((e) => e.pdu.type === 'm.room.create');
  if (creates.length !== 1) {
    throw new MatrixError(502, 'M_UNKNOWN', 'snapshot has no single create');
  }
  const createContent =
    (creates[0].pdu.content == null ? {} : creates[0].pdu.content) as {
      room_version?: unknown;
    };
  if (
    String(
      createContent.room_version == null ? '' : createContent.room_version,
    ) !== roomVersion
  ) {
    throw new MatrixError(
      502,
      'M_UNKNOWN',
      `snapshot create says room_version ${
        String(createContent.room_version)
      }, expected ${roomVersion}`,
    );
  }
  // auth rules 1–2 against the snapshot's own auth chain, topologically
  const store = {
    get: (id: string) => byId.get(id),
    isRejected: (id: string) =>
      events.find((e) => e.eventId === id)?.rejected === true,
  };
  const rulebook = getRulebook(roomVersion);
  const byDepth = [...events].sort((a, b) => a.pdu.depth - b.pdu.depth);
  for (const e of byDepth) {
    if (e.pdu.type === 'm.room.create') continue;
    const chain = rulebook.checkAuthChain(e.pdu, store);
    if (!chain.ok) e.rejected = true;
  }
  // the snapshot's state rows = the ACCEPTED state events
  const stateRows: StateRowInput[] = [];
  for (const raw of state) {
    const rawId = (raw as Record<string, unknown>).event_id;
    const id = String(rawId == null ? '' : rawId);
    const e = events.find((x) => x.eventId === id);
    if (e === undefined || e.rejected === true) continue;
    if (e.pdu.state_key === undefined) continue;
    stateRows.push({
      type: String(e.pdu.type),
      stateKey: String(e.pdu.state_key),
      eventId: e.eventId,
      content: e.pdu.content == null ? {} : e.pdu.content,
    });
  }
  return { events, stateRows };
}

// §3.6 steps 4–9: the dance. candidates per §3.6 step 2 / §3.6b.
export async function joinRemoteRoom(
  roomId: string,
  userId: string,
  candidates: string[],
  extraContent?: Record<string, unknown>,
): Promise<{ roomId: string; eventId: string }> {
  let lastError: unknown = null;
  for (const candidate of candidates) {
    // the gate was passed when the relationship was made — admit per
    // candidate (closed mode → pending row + the client-facing 403)
    await admit(candidate, {
      kind: 'outbound',
      user: userId,
      what: `join ${roomId}`,
    });
    try {
      // 4. make_join
      const mk = await federationRequest({
        destination: candidate,
        method: 'GET',
        path: `/_matrix/federation/v1/make_join/${encodeURIComponent(roomId)}/${
          encodeURIComponent(userId)
        }?ver=${supportedRoomVersions().map(encodeURIComponent).join('&ver=')}`,
        body: null,
      });
      // the spec's wrapper (joins-v1.yaml:55-81): room_version + event
      const mkBody = mk.json as { room_version?: unknown; event?: unknown };
      const roomVersion = String(
        mkBody.room_version == null ? '11' : mkBody.room_version,
      );
      const template = (mkBody.event == null ? {} : mkBody.event) as Record<
        string,
        unknown
      >;
      // 5. build the event from the template: our origin/ts, keep
      //    prev/auth/depth, drop any hashes/signatures/unsigned, fill
      //    content from our profile, hash, id, sign with the tenant key
      const profile = await getProfile(serverName(), localpartOf(userId));
      const pdu: Pdu = {
        type: 'm.room.member',
        state_key: userId,
        sender: userId,
        room_id: roomId,
        content: {
          ...(profile?.displayname !== undefined
            ? { displayname: profile.displayname }
            : {}),
          ...(profile?.avatar_url !== undefined
            ? { avatar_url: profile.avatar_url }
            : {}),
          ...(extraContent == null ? {} : extraContent),
          membership: 'join',
        },
        prev_events: (template.prev_events == null
          ? []
          : template.prev_events) as string[],
        auth_events: (template.auth_events == null
          ? []
          : template.auth_events) as string[],
        depth: Number(template.depth == null ? 1 : template.depth),
        origin_server_ts: Date.now(),
        hashes: { sha256: '' },
        signatures: {},
      };
      const key = await getTenantKey();
      await signPdu(pdu, roomVersion, key);
      const eventId = String(pdu.event_id);
      // 6. send_join v2 → v1 only on endpoint-unknown
      let resp: Record<string, unknown>;
      try {
        const res = await federationRequest({
          destination: candidate,
          method: 'PUT',
          path: `/_matrix/federation/v2/send_join/${
            encodeURIComponent(roomId)
          }/${encodeURIComponent(eventId)}`,
          body: new TextEncoder().encode(
            JSON.stringify(toWire(pdu, roomVersion)),
          ),
        });
        resp = res.json as Record<string, unknown>;
      } catch (e) {
        if (!isEndpointUnknown(e)) {
          throw e;
        }
        const res = await federationRequest({
          destination: candidate,
          method: 'PUT',
          path: `/_matrix/federation/v1/send_join/${
            encodeURIComponent(roomId)
          }/${encodeURIComponent(eventId)}`,
          body: new TextEncoder().encode(
            JSON.stringify(toWire(pdu, roomVersion)),
          ),
        });
        const arr = res.json as unknown[];
        resp = (arr[1] == null ? {} : arr[1]) as Record<string, unknown>;
      }
      // 7. the snapshot checks
      const state = (resp.state == null ? [] : resp.state) as Record<
        string,
        unknown
      >[];
      const authChain =
        (resp.auth_chain == null ? [] : resp.auth_chain) as Record<
          string,
          unknown
        >[];
      const checked = await checkSnapshot(
        roomId,
        roomVersion,
        state,
        authChain,
        candidate,
        eventId,
      );
      // 8–9. provision / pair / root / join — inside the room lock
      await withRoomLock(roomId, async () => {
        const held = await lookupRoom(roomId);
        let stay: string;
        if (held === null) {
          await provisionRoom(roomId, roomVersion);
          stay = 'chapter1';
        } else {
          stay = (await allocateChapterPair(roomId)).stay;
        }
        // (i) the resident's signature on the returned event when present
        //     and verifying — use that copy; else our signed copy
        let join = pdu;
        const returned = resp.event as Record<string, unknown> | undefined;
        if (returned !== undefined) {
          const rp = returned as unknown as Pdu;
          (rp as unknown as Record<string, unknown>).event_id = eventId;
          const rpSigs = rp.signatures == null ? {} : rp.signatures;
          const rpKids = rpSigs[candidate] == null ? {} : rpSigs[candidate];
          for (const kid of Object.keys(rpKids)) {
            try {
              const rk = await getVerifyKey(candidate, kid, 0, 'event', {
                roomId,
              });
              if (
                await verifyPduSignature(rp, rk, candidate, kid, roomVersion)
              ) {
                join = rp;
                break;
              }
            } catch {
              /* next */
            }
          }
        }
        await ingestJoinSnapshotLocked(roomId, {
          chapter: stay,
          rootEvents: checked.events,
          rootStateRows: checked.stateRows,
          join,
          rootMessage: `remote snapshot before ${eventId}`,
          origin: candidate,
          newEvidence: true,
        });
      });
      return { roomId, eventId };
    } catch (e) {
      if (isFailover(e)) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  if (lastError !== null) throw lastError;
  throw new MatrixError(404, 'M_NOT_FOUND', 'no servers to join through');
}
