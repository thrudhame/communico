// api/engine/room/join.ts — joining a room hosted elsewhere (3c-2):
// make_join → build the join from the resident's template → sign →
// send_join → the returned snapshot is validated BEFORE anything is
// written (every state/auth-chain event through the ONE verification
// path and checked against its auth events; the returned join must
// match ours; the room file is only created after validation passes —
// plan §3). Then one room transaction under the per-room lock: the
// auth chain and state events stored as `evidence` (R2 — bytes, never
// state-at), the imported snapshot group built (provenance `imported`,
// R5/G1 — the boundary is stored, never recomputed from absent prevs),
// a new stay opened on it, the join ingested with before = the
// snapshot, extremities = [join], publication and the membership
// change logged. Via servers are tried in order — network failure,
// 5xx, 404 M_NOT_FOUND and M_UNABLE_TO_(AUTHORISE|GRANT)_JOIN fail
// over; other 4xx abort (the old classification). Network never runs
// under the lock (R13).
import { canonicalJson } from '#engine/canonical.ts';
import { withAuthProofs } from '#engine/auth-proofs.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  type EventStore,
  getRulebook,
  type Rulebook,
  supportedRoomVersions,
} from '#engine/rulebook/index.ts';
import {
  checkDeclaredAuth,
  finalizeBuilt,
  roomCreateId,
} from '#engine/room/build.ts';
import type { Fetcher, KeyResolver } from '#engine/room/deps.ts';
import { projectAfterWrite, registerCreatedRoom } from '#engine/room/hooks.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { openRoom } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import type { Signer } from '#engine/room/signer.ts';
import { orderEvents } from '#engine/room/order.ts';
import { mapEntries, type StateMap } from '#engine/room/state.ts';
import { identify, oversizedOf, verify } from '#engine/room/verify.ts';
import type { Store } from '#engine/store/index.ts';

export type JoinDeps = {
  keys: KeyResolver;
  fetcher: Fetcher;
  self: string;
};

export type JoinResult = { roomId: string; eventId: string };

// Verify one snapshot event through the ONE verification path (G9).
// Our own events ride the snapshot back to us (a re-join's snapshot
// carries our first join): their sender-domain key is not resolvable
// through the injected resolver, so — as in the old snapshot semantics
// — the RESIDENT's signature also proves the event (it vouches for the
// snapshot it serves). Both failing refuses the response.
async function verifySnapshotEvent(
  raw: Pdu,
  roomVersion: string,
  candidate: string,
  roomId: string,
  keys: KeyResolver,
  self: string,
): Promise<{ eventId: string; pdu: Pdu }> {
  return await verify(raw, roomVersion, keys, {
    roomId,
    localSnapshotFallback: { self, resident: candidate },
  });
}

// Fail over to the next candidate on network failure, 5xx,
// 404 M_NOT_FOUND and the M_UNABLE_TO_* join errcodes; abort on other
// 4xx (403, M_INCOMPATIBLE_ROOM_VERSION — the old classification).
function isFailover(e: unknown): boolean {
  const err = e as { status?: number; errcode?: string };
  if (typeof err.status !== 'number') return true;
  if (err.status >= 500) return true;
  if (err.status === 404 && err.errcode === 'M_NOT_FOUND') return true;
  return err.errcode === 'M_UNABLE_TO_AUTHORISE_JOIN' ||
    err.errcode === 'M_UNABLE_TO_GRANT_JOIN';
}

// A candidate whose RESPONSE is untrusted fails over (502), like the
// old checkSnapshot.
function badResponse(message: string): MatrixError {
  return new MatrixError(502, 'M_UNKNOWN', message);
}

export async function joinRemote(
  store: Store,
  args: {
    roomId: string;
    user: string;
    via: string[];
    signer: Signer;
    deps: JoinDeps;
    content?: Record<string, unknown>;
  },
): Promise<JoinResult> {
  let lastError: unknown = null;
  for (const candidate of args.via) {
    try {
      return await joinVia(store, args, candidate);
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

async function joinVia(
  store: Store,
  args: {
    roomId: string;
    user: string;
    signer: Signer;
    deps: JoinDeps;
    content?: Record<string, unknown>;
  },
  candidate: string,
): Promise<JoinResult> {
  const { deps } = args;

  // 1. make_join — the resident's template names the room's version
  const mk = await deps.fetcher.makeJoin(
    args.roomId,
    args.user,
    supportedRoomVersions(),
    candidate,
  );
  let rulebook: Rulebook;
  try {
    rulebook = getRulebook(mk.roomVersion);
  } catch {
    throw new MatrixError(
      400,
      'M_INCOMPATIBLE_ROOM_VERSION',
      `This server does not know how to join a room of version ${mk.roomVersion}`,
    );
  }

  // 2. build the join from the template (the resident's prevs, auth
  //    events and depth; our content) and sign it
  const template = mk.event;
  const pdu: Pdu = {
    type: 'm.room.member',
    state_key: args.user,
    sender: args.user,
    room_id: args.roomId,
    content: { ...(args.content ?? {}), membership: 'join' },
    prev_events: template.prev_events ?? [],
    auth_events: template.auth_events ?? [],
    depth: template.depth ?? 1,
    origin_server_ts: Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  const signed = await finalizeBuilt(pdu, rulebook, args.signer);
  const eventId = String(signed.event_id);

  // 3. send_join — the answer is untrusted input
  const resp = await deps.fetcher.sendJoin(args.roomId, signed, candidate);

  // 4. validate BEFORE anything is written: every returned event
  //    through the ONE verification path (G9) and checked against its
  //    auth events; the returned join must match ours; the join must
  //    be authorized by the snapshot
  const pack = new Map<string, Pdu>();
  const stateEventIds: string[] = [];
  for (const raw of resp.state ?? []) {
    const v = await verifySnapshotEvent(
      raw,
      mk.roomVersion,
      candidate,
      args.roomId,
      deps.keys,
      deps.self,
    );
    if (!pack.has(v.eventId)) pack.set(v.eventId, v.pdu);
    stateEventIds.push(v.eventId);
  }
  for (const raw of resp.authChain ?? []) {
    const v = await verifySnapshotEvent(
      raw,
      mk.roomVersion,
      candidate,
      args.roomId,
      deps.keys,
      deps.self,
    );
    if (!pack.has(v.eventId)) pack.set(v.eventId, v.pdu);
  }
  // Per-event auth checks in dependency order: a rejected STATE event
  // refuses the response; a rejected auth-chain-only event is excluded
  const rejected = new Map([...pack.keys()].map((id) => [id, 'unchecked']));
  const packStore: EventStore = await withAuthProofs({
    get: (id) => pack.get(id),
    isRejected: (id) => rejected.has(id),
  }, pack.values());
  const stateIdSet = new Set(stateEventIds);
  const snapshotCreates = [...stateIdSet].filter((id) =>
    pack.get(id)?.type === 'm.room.create'
  );
  if (snapshotCreates.length !== 1) {
    throw badResponse('snapshot has no single create');
  }
  const ordered = orderEvents(
    [...pack].map(([eventId, pdu]) => ({ eventId, pdu })),
    ['auth_events'],
  ).map(({ eventId, pdu }) => [eventId, pdu] as const);
  for (const [id, eventPdu] of ordered) {
    rejected.delete(id);
    const chain = checkDeclaredAuth(
      eventPdu,
      rulebook,
      packStore,
      snapshotCreates[0],
    );
    if (!chain.ok) {
      if (stateIdSet.has(id)) {
        throw badResponse(
          `snapshot state event not authorized (${chain.rule}): ${id}`,
        );
      }
      rejected.set(id, chain.rule);
    }
  }
  // exactly one create among the accepted state events, for the
  // template's version
  const creates = stateEventIds
    .filter((id) => !rejected.has(id))
    .map((id) => pack.get(id)!)
    .filter((eventPdu) => eventPdu.type === 'm.room.create');
  if (creates.length !== 1) {
    throw badResponse('snapshot has no single create');
  }
  if (String(creates[0].content?.room_version ?? '') !== mk.roomVersion) {
    throw badResponse(
      `snapshot create says room_version ${
        String(creates[0].content?.room_version)
      }, expected ${mk.roomVersion}`,
    );
  }
  // the snapshot: the accepted state events (the imported boundary —
  // the state PRIOR to the join, joins-v2.yaml)
  const snapshot: StateMap = new Map();
  for (const id of stateEventIds) {
    if (rejected.has(id)) continue;
    const eventPdu = pack.get(id)!;
    if (eventPdu.state_key === undefined) continue;
    snapshot.set(String(eventPdu.type) + '\0' + String(eventPdu.state_key), id);
  }
  // the returned join: recomputed id must match ours and the resident's
  // signature must verify (it vouches for the event it accepted); else
  // the response is refused. The sender-domain signature is OURS — the
  // joiner's, already proven at build time — so the resident's entry is
  // the one checked here.
  let join = signed;
  if (resp.event !== undefined) {
    const returned = resp.event;
    let identifiedId: string;
    try {
      identifiedId = (await identify(returned, mk.roomVersion, {
        roomId: args.roomId,
      })).eventId;
    } catch (e) {
      throw badResponse('the returned join is malformed: ' + String(e));
    }
    if (identifiedId !== eventId) {
      throw badResponse('the returned join does not match ours');
    }
    const residentSigs = (returned.signatures as
      | Record<string, Record<string, string>>
      | undefined)?.[candidate] ?? {};
    const verifiedSigs: Record<string, string> = {};
    for (const keyId of Object.keys(residentSigs)) {
      try {
        if (
          await deps.keys.verifyEventSignature({
            server: candidate,
            keyId,
            pdu: returned,
            roomVersion: mk.roomVersion,
            minValidUntilMs: 0,
          })
        ) {
          verifiedSigs[keyId] = residentSigs[keyId];
          break;
        }
      } catch {
        // key unobtainable under this id — try the next
      }
    }
    if (Object.keys(verifiedSigs).length === 0) {
      throw badResponse('the returned join is not vouched by the resident');
    }
    join = {
      ...signed,
      signatures: {
        ...signed.signatures,
        [candidate]: {
          ...signed.signatures?.[candidate],
          ...verifiedSigs,
        },
      },
    };
  }
  // the join against the snapshot: its auth events and the state before
  const joinStore: EventStore = await withAuthProofs({
    get: (id) => id === eventId ? join : pack.get(id),
    isRejected: (id) => rejected.has(id),
  }, [...pack.values(), join]);
  const joinChain = checkDeclaredAuth(
    join,
    rulebook,
    joinStore,
    String(creates[0].event_id),
  );
  if (!joinChain.ok) {
    throw badResponse(
      `the join is not authorized by its auth events (${joinChain.rule})`,
    );
  }
  const joinState = rulebook.checkAuthAgainstState(join, snapshot, joinStore);
  if (!joinState.ok) {
    throw badResponse(
      `the join is not authorized against the snapshot state (${joinState.rule})`,
    );
  }

  // 5. the room file (safe create when absent — validation has passed),
  //    then ONE transaction (G11). room-first: the registry follows the
  //    file's existence (a crash between the two is the startup
  //    discovery's window).
  const room = await openRoom(store, args.roomId, { create: true });
  await registerCreatedRoom(store, args.roomId);
  await withRoomLock(args.roomId, () =>
    room.tx(async (tx) => {
      // revalidation (G8): a live stay means the room is already joined
      if ((await tx.segments.openStay()) !== null) {
        throw new MatrixError(
          400,
          'M_BAD_STATE',
          'already joined to ' + args.roomId,
        );
      }
      const prevStay = (await tx.segments.list())
        .filter((segment) => segment.kind === 'stay')
        .pop() ?? null;
      if (
        prevStay !== null &&
        await roomCreateId(tx, prevStay.id) !== String(creates[0].event_id)
      ) {
        throw badResponse('snapshot replaces the room create');
      }

      // the auth chain and state events as EVIDENCE (R2 — first writer
      // wins; bytes, never state-at, never positioned)
      for (const [id, eventPdu] of ordered) {
        if ((await tx.events.get(id)) !== null) continue;
        const rule = rejected.get(id) ?? null;
        await tx.events.insert(
          id,
          canonicalJson(eventPdu as unknown as Record<string, unknown>),
        );
        await tx.events.setStatus(id, {
          standing: rule === null ? 'accepted' : 'rejected',
          grounding: 'evidence',
          origin: candidate,
          received_ts: Date.now(),
        });
        await tx.changes.append('event', id, {
          standing: rule === null ? 'accepted' : 'rejected',
          reason: rule === null ? null : 'auth',
          rule,
          type: String(eventPdu.type),
          state_key: eventPdu.state_key ?? null,
          sender: String(eventPdu.sender),
          depth: eventPdu.depth,
          origin_server_ts: eventPdu.origin_server_ts,
          stay: null,
          offset: null,
          grounding: 'evidence',
          origin: candidate,
        });
      }

      // the imported snapshot group (R5/G1) opens the new stay; the
      // join is ingested with before = the snapshot — the pipeline
      // positions it, sets the frontier, publishes and logs the
      // membership change
      const snapshotGroup = await tx.materialize.newGroup(
        null,
        mapEntries(snapshot),
      );
      const stayId = await tx.segments.create({
        kind: 'stay',
        prev: prevStay?.id ?? null,
        opening_group: snapshotGroup,
      });
      const result = await ingestInTx(tx, args.roomId, join, {
        remote: {
          origin: candidate,
          self: deps.self,
          oversized: oversizedOf(join, mk.roomVersion),
          ungroundedMs: 0,
          boundary: snapshot,
        },
      });
      if (result.standing !== 'accepted') {
        throw new Error(
          `E_JOIN_NOT_ACCEPTED: ${result.standing} (${result.reason ?? ''}${
            result.rule === null ? '' : ', rule ' + result.rule
          })`,
        );
      }
      await tx.segments.setOpenedBy(stayId, eventId);
    }));
  await projectAfterWrite(store, args.roomId);
  return { roomId: args.roomId, eventId };
}
