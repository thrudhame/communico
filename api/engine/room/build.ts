// api/engine/room/build.ts — build a local PDU for a room version (plan
// §2.3): prev_events from the live stay's extremities (≤ 20, deterministic
// sorted order) or explicit, depth = max prev depth + 1, auth_events via
// the rulebook's selection over the state BEFORE the event, then content
// hash, signature and reference-hash id (spec server-server-api § "Adding
// hashes and signatures to outgoing events": hash -> redact -> sign).
// Also home to the tx-scoped resolution helpers ingest shares: prev
// grounding, the bounded auth-closure rulebook store and the state-before
// computation (single-prev ingest never resolves — it aliases the
// parent's after-group).
import { assertCanonicalNumbers, canonicalJson } from '#engine/canonical.ts';
import { withAuthProofs } from '#engine/auth-proofs.ts';
import { eventIdFor, redact } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  type EventStore,
  getRulebook,
  type Rulebook,
  type StateMap,
} from '#engine/rulebook/index.ts';
import type { RoomTx } from '#engine/room/index.ts';
import { edgeIds } from '#engine/room/events.ts';
import type { Signer } from '#engine/room/signer.ts';
import { contentHashOf } from '#engine/signing-primitives.js';

// Counts rulebook resolveState calls (the plan's instrumented guardrail:
// a single-prev linear ingest performs no resolution).
export { resolutionProbe } from '#engine/room/index.ts';

// The auth closure feeding the rulebook is a bounded indexed walk (R3);
// a truncated walk is a loud failure, never a silent partial store.
const AUTH_CLOSURE_LIMIT = 100_000;

export type BuildPartial = {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  state_key?: string;
  // Explicit prevs (fork/delayed operations); the default is the live
  // stay's current extremities.
  prev_events?: string[];
  origin_server_ts?: number;
  // ≤10 redaction events carry the target id top-level (pdu_v6.yaml:27-30);
  // v11+ keeps it under content.
  redacts?: string;
};

// The room's version is read from the accepted m.room.create in the
// stay's current state (a second create is always rejected, so it is
// unique). The create event itself supplies its own content.room_version.
export async function roomVersionOf(
  tx: RoomTx,
  stayId: number,
): Promise<string> {
  const group = await tx.state.current(stayId);
  if (group === null) throw new Error('E_NO_STATE: stay has no current state');
  const createId = await tx.state.groupKey(group, 'm.room.create', '');
  if (createId === null) {
    throw new Error('M_NO_CREATE: current state has no create event');
  }
  const create = await tx.events.get(createId);
  const version = create === null
    ? undefined
    : (JSON.parse(create.pdu) as { content?: { room_version?: unknown } })
      .content?.room_version;
  if (typeof version !== 'string') {
    throw new Error('M_NO_CREATE: create event lacks content.room_version');
  }
  return version;
}

// Prev grounding: every cited prev must be held with a genuine after-state
// (provenance dag/imported; rejected/soft-failed prevs are grounding — old
// rule: their state is real). Unknown or stateless prevs never ground.
export type ResolvedPrevs = {
  ids: string[];
  afterGroups: number[];
  depths: number[];
};

export async function resolvePrevs(
  tx: RoomTx,
  prevIds: readonly string[],
): Promise<ResolvedPrevs> {
  const ids = [...prevIds];
  const afterGroups: number[] = [];
  const depths: number[] = [];
  for (const id of ids) {
    const row = await tx.events.get(id);
    const after = row === null ? null : await tx.state.eventStateAfter(id);
    if (row === null || after === null) {
      throw new Error('M_UNKNOWN_PREV: ' + id);
    }
    afterGroups.push(after.group);
    depths.push(row.depth);
  }
  return { ids, afterGroups, depths };
}

// The cited prevs that do not ground an event: unknown, or held without
// a genuine after-state — pending and evidence events carry bytes, not
// state-at-event (G2).
export async function ungroundedPrevs(
  tx: RoomTx,
  prevIds: readonly string[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const id of prevIds) {
    const row = await tx.events.get(id);
    const after = row === null ? null : await tx.state.eventStateAfter(id);
    if (row === null || after === null) missing.push(id);
  }
  return missing;
}

// The rulebook's synchronous EventStore over the bounded recursive auth
// closure of the seeds, with rejected flags (S4 155-194). The room create
// is an invariant dependency: v12 refers to it through room_id instead of
// auth_events, including when an evidence/history check has no state seeds.
export async function loadRulebookStore(
  tx: RoomTx,
  seeds: readonly string[],
  incoming: readonly Pdu[] = [],
  localRejected: ReadonlySet<string> = new Set(),
): Promise<EventStore> {
  const roots = new Set([
    ...seeds,
    ...incoming.flatMap((pdu) => pdu.auth_events ?? []),
  ]);
  const stay = await tx.segments.latestStay();
  const current = stay === null ? null : await tx.state.current(stay.id);
  const create = current === null
    ? null
    : await tx.state.groupKey(current, 'm.room.create', '');
  if (create !== null) roots.add(create);
  const walk = await tx.events.authClosure([...roots], AUTH_CLOSURE_LIMIT);
  if (walk.truncated) {
    throw new Error(
      `E_AUTH_CLOSURE: auth closure exceeds ${AUTH_CLOSURE_LIMIT} events`,
    );
  }
  const ids = [...new Set([...roots, ...walk.ids])];
  const rows = await tx.events.list(ids);
  const standings = await tx.events.statuses(ids);
  const pdus = new Map<string, Pdu>();
  const rejected = new Set<string>();
  for (const [id, row] of rows) {
    pdus.set(id, JSON.parse(row.pdu) as Pdu);
  }
  for (const [id, status] of standings) {
    if (status.standing === 'rejected') rejected.add(id);
  }
  for (const pdu of incoming) pdus.set(String(pdu.event_id), pdu);
  return await withAuthProofs({
    get: (id) => pdus.get(id),
    isRejected: (id) => localRejected.has(id) || rejected.has(id),
  }, pdus.values());
}

// Evidence has no DAG state, but its declared auth events must authorize it.
// The structural rules (1-2) alone do not check membership or TPI proofs.
// Reuse the pure state rules over that exact auth set, never room-current state.
export function checkDeclaredAuth(
  pdu: Pdu,
  rulebook: Rulebook,
  store: EventStore,
) {
  const chain = rulebook.checkAuthChain(pdu, store);
  if (!chain.ok) return chain;
  const state: StateMap = new Map();
  for (const id of pdu.auth_events ?? []) {
    const auth = store.get(id);
    if (auth?.state_key !== undefined) {
      state.set(auth.type + '\0' + auth.state_key, id);
    }
  }
  if (rulebook.spec.roomIdFromCreateEvent && typeof pdu.room_id === 'string') {
    const id = '$' + pdu.room_id.slice(1);
    if (store.get(id)?.type === 'm.room.create') {
      state.set('m.room.create\0', id);
    }
  }
  return rulebook.checkAuthAgainstState(pdu, state, store);
}

// Imported state is usable only after every named event was authorized.
// A rejected/missing event must never become state merely because a peer
// listed its id in a snapshot or /state_ids response.
export function authorizedBoundary(
  state: StateMap,
  store: EventStore,
): boolean {
  for (const [key, id] of state) {
    const pdu = store.get(id);
    if (
      pdu === undefined || store.isRejected(id) ||
      pdu.state_key === undefined || key !== pdu.type + '\0' + pdu.state_key
    ) return false;
  }
  return true;
}

// Publication reuses authorization's already-loaded graph, extended by the
// newly accepted event. Its seeds can differ, so preserve the closure guard
// (including unknown ids) with an in-memory walk, never another DB load.
export function withRulebookEvent(
  store: EventStore,
  eventId: string,
  pdu: Pdu,
  seeds: readonly string[],
  limit = AUTH_CLOSURE_LIMIT,
): EventStore {
  const extended: EventStore = {
    ...store,
    get: (id) => id === eventId ? pdu : store.get(id),
    isRejected: (id) => id === eventId ? false : store.isRejected(id),
  };
  const visited = new Set<string>();
  const queue = [...seeds];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    if (visited.has(id)) continue;
    if (visited.size >= limit) {
      throw new Error(`E_AUTH_CLOSURE: auth closure exceeds ${limit} events`);
    }
    visited.add(id);
    for (const auth of edgeIds(extended.get(id)?.auth_events)) {
      if (!visited.has(auth)) queue.push(auth);
    }
  }
  return extended;
}

// The state before an event citing the given prevs: the single prev's
// after-group aliased (no resolution — the plan's performance guardrail),
// or the rulebook resolution over every prev's after-state.
export async function stateBefore(
  tx: RoomTx,
  afterGroups: readonly number[],
  rulebook: Rulebook,
  store?: EventStore,
): Promise<StateMap> {
  if (afterGroups.length === 0) return new Map();
  if (afterGroups.length === 1) {
    return await tx.state.groupMap(afterGroups[0]);
  }
  const maps: StateMap[] = [];
  for (const group of afterGroups) maps.push(await tx.state.groupMap(group));
  const resolver = store === undefined
    ? await loadRulebookStore(
      tx,
      maps.flatMap((map) => [...map.values()]),
    )
    : store;
  tx.diagnostics.resolutions++;
  return rulebook.resolveState(maps, resolver);
}

// Shared finalization (buildInTx / buildCreate / join.ts's template
// build): canonical-number guard, content hash, redact-then-sign,
// reference-hash id, size and depth caps (old author's D8/D9).
export async function finalizeBuilt(
  pdu: Pdu,
  rulebook: Rulebook,
  signer: Signer,
): Promise<Pdu> {
  const version = rulebook.spec.identifier;
  if (rulebook.spec.strictCanonicalJson) {
    assertCanonicalNumbers(pdu.content);
  }
  // Authored events name us before hashing/signing, including template builds.
  // Received events use verification/countersigning, never this finalizer.
  pdu.origin = signer.serverName;
  // The v11+ wire form has no event_id field: it is derived, never hashed
  // or signed. It is absent at build time.
  pdu.hashes = { sha256: await contentHashOf(pdu) };
  const redacted = redact(
    pdu as unknown as Record<string, unknown>,
    version,
  );
  delete redacted.event_id;
  // the signature payload carries no signatures (spec § Signing JSON)
  delete redacted.signatures;
  const signature = await signer.sign(canonicalJson(redacted));
  pdu.signatures = { [signer.serverName]: { [signer.keyId]: signature } };
  pdu.event_id = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    version,
  );
  if (new TextEncoder().encode(canonicalJson(pdu)).length > 65536) {
    throw new MatrixError(
      413,
      'M_TOO_LARGE',
      'event exceeds the 65536-byte limit',
    );
  }
  const depthBound = rulebook.spec.depthLimit === 'int53'
    ? 2 ** 53 - 1
    : 2 ** 63 - 1;
  if ((pdu.depth as number) > depthBound) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'event depth exceeds the room version limit',
    );
  }
  return pdu;
}

// Build a local PDU inside the caller's room transaction: prevs default to
// the live stay's extremities (deterministic sorted order from the 3a
// frontier read), depth = max prev depth + 1, auth events selected over
// the state before the event.
export async function buildInTx(
  tx: RoomTx,
  roomId: string,
  partial: BuildPartial,
  signer: Signer,
): Promise<Pdu> {
  const isCreate = partial.type === 'm.room.create' &&
    (partial.prev_events ?? []).length === 0;
  const stay = await stayForEvent(tx, partial);
  if (stay === null && !isCreate) {
    throw new Error('E_ROOM_ARCHIVED: no open stay for ' + roomId);
  }
  const version = isCreate
    ? String(partial.content?.room_version)
    : await roomVersionOf(tx, stay!.id);
  const rulebook = getRulebook(version);

  const prevIds = partial.prev_events ??
    (stay === null ? [] : await tx.extremities.frontier(stay.id));
  if (prevIds.length > 20) {
    throw new Error('M_TOO_MANY_PREV_EVENTS: v11 allows at most 20');
  }
  const prevs = await resolvePrevs(tx, prevIds);
  const depth = prevs.ids.length === 0 ? 1 : Math.max(...prevs.depths) + 1;
  const before = await stateBefore(tx, prevs.afterGroups, rulebook);

  const pdu: Pdu = {
    type: partial.type,
    sender: partial.sender,
    content: partial.content ?? {},
    prev_events: [...prevIds],
    auth_events: rulebook.selectAuthEvents(
      {
        type: partial.type,
        sender: partial.sender,
        state_key: partial.state_key,
        content: partial.content ?? {},
      } as Pdu,
      before,
    ),
    depth,
    origin_server_ts: partial.origin_server_ts ?? Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  if (!(rulebook.spec.roomIdFromCreateEvent && isCreate)) {
    pdu.room_id = roomId;
  }
  if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
  if (partial.redacts !== undefined) pdu.redacts = partial.redacts;
  return await finalizeBuilt(pdu, rulebook, signer);
}

// The archived-room carve-out is a property of the event, not a caller
// flag: only an invited user's self-leave may land on the closed stay.
// Used by both authoring and ingest (local and federation consumers).
export async function stayForEvent(
  tx: RoomTx,
  event: Pick<BuildPartial, 'type' | 'sender' | 'state_key' | 'content'>,
) {
  const live = await tx.segments.openStay();
  if (live !== null) return live;
  if (
    event.type !== 'm.room.member' || event.sender !== event.state_key ||
    event.content?.membership !== 'leave'
  ) return null;
  const last = await tx.segments.latestStay();
  const group = last === null ? null : await tx.state.current(last.id);
  const id = group === null
    ? null
    : await tx.state.groupKey(group, 'm.room.member', event.sender);
  const row = id === null ? null : await tx.events.get(id);
  return row !== null &&
      (JSON.parse(row.pdu) as Pdu).content?.membership === 'invite'
    ? last
    : null;
}

// Build an m.room.create outside any room transaction: the v12 room id is
// derived from the create's event id, so the create is built before the
// room exists (prevs empty, depth 1, empty before-state, no auth events).
export async function buildCreate(
  args: {
    sender: string;
    content: Record<string, unknown>;
    origin_server_ts?: number;
    roomId?: string;
  },
  signer: Signer,
  version: string,
): Promise<Pdu> {
  const rulebook = getRulebook(version);
  const pdu: Pdu = {
    type: 'm.room.create',
    sender: args.sender,
    state_key: '',
    content: args.content,
    prev_events: [],
    auth_events: [],
    depth: 1,
    origin_server_ts: args.origin_server_ts ?? Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  if (!rulebook.spec.roomIdFromCreateEvent) {
    if (args.roomId === undefined) {
      throw new Error('E_CREATE_ROOM_ID: a pre-v12 create needs its room id');
    }
    pdu.room_id = args.roomId;
  }
  return await finalizeBuilt(pdu, rulebook, signer);
}
