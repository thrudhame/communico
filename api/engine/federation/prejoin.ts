// Federation keeps full create PDUs; client display gets stripped state only.
// This data is a prejoin hint, never authoritative room auth/encryption state.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import type { Room, RoomTx } from '#engine/room/index.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { identify, verify } from '#engine/room/verify.ts';
import { toWire } from './pdu.ts';
import { erasurePrunes } from '#engine/erasure.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { redactionOf } from '#engine/server/read.ts';
import { redact } from '#engine/eventid.ts';

export const prejoinTypes = new Set([
  'm.room.create',
  'm.room.name',
  'm.room.avatar',
  'm.room.topic',
  'm.room.join_rules',
  'm.room.canonical_alias',
  'm.room.encryption',
]);
export function stripPrejoin(pdu: Record<string, unknown>) {
  return {
    type: pdu.type,
    state_key: pdu.state_key,
    content: pdu.content,
    sender: pdu.sender,
    ...(pdu.type === 'm.room.create'
      ? { origin_server_ts: pdu.origin_server_ts }
      : {}),
  };
}
async function selectedPrejoin(tx: RoomTx, ids: string[], member: string) {
  const out: { id: string; pdu: Pdu }[] = [];
  for (const [id, row] of await tx.events.list(ids)) {
    if ((await tx.events.getStatus(id))?.standing !== 'accepted') continue;
    const type = row.type, stateKey = row.state_key;
    if (
      !prejoinTypes.has(type) &&
      !(type === 'm.room.member' && stateKey === member)
    ) continue;
    const pdu = JSON.parse(row.pdu) as Pdu;
    out.push({ id, pdu });
  }
  return out;
}
export async function prejoinStateInTx(
  tx: RoomTx,
  member: string,
): Promise<Record<string, unknown>[]> {
  const stay = await tx.segments.openStay();
  if (stay === null) return [];
  const group = await tx.state.current(stay.id);
  if (group === null) return [];
  const version = await roomVersionOf(tx, stay.id);
  return (await selectedPrejoin(tx, [
    ...(await tx.state.groupMap(group)).values(),
  ], member))
    .map(({ pdu }) => toWire(pdu, version));
}
export function prejoinState(room: Room, member: string) {
  return room.tx((tx) => prejoinStateInTx(tx, member));
}

// Shape intersection is recursive and never sources a value from room truth.
// An incompatible array fails as a whole, rather than shifting element indexes.
export function savedContentView(saved: unknown, allowed: unknown): unknown {
  if (saved === null || allowed === null) {
    return saved === allowed ? null : undefined;
  }
  if (typeof saved !== typeof allowed) return undefined;
  if (Array.isArray(saved) || Array.isArray(allowed)) {
    if (!Array.isArray(saved) || !Array.isArray(allowed)) return undefined;
    if (saved.length > allowed.length) return undefined;
    const out = [];
    for (let i = 0; i < saved.length; i++) {
      const item = savedContentView(saved[i], allowed[i]);
      if (item === undefined) return undefined;
      out.push(item);
    }
    return out;
  }
  if (typeof saved === 'object') {
    const projected = allowed as Record<string, unknown>;
    const out: [string, unknown][] = [];
    for (const [key, value] of Object.entries(saved)) {
      if (!Object.hasOwn(projected, key)) continue;
      const item = savedContentView(value, projected[key]);
      if (item !== undefined) out.push([key, item]);
    }
    return Object.fromEntries(out);
  }
  return saved;
}

// One display decision for held and saved sources. Apply the existing room-
// version redaction algorithm to the saved event itself; a source view supplies
// only a further shape ceiling, never values or a second redaction allow-list.
async function shownPrejoin(
  room: Room,
  source: { id: string; pdu: Pdu },
  version: string,
  viewer: { userId: string; tenant: Tenant },
  saved = source.pdu as unknown as Record<string, unknown>,
) {
  const pruned =
    await redactionOf(await room.store.server(), room.id, source.id) !== null ||
    await erasurePrunes(room, source.id, source.pdu, {
      userId: viewer.userId,
    }, viewer.tenant);
  const ceiling = pruned
    ? redact(source.pdu as unknown as Record<string, unknown>, version)
    : source.pdu;
  const shown = pruned ? redact(saved, version) : saved;
  const content = savedContentView(shown.content, ceiling.content);
  return stripPrejoin({
    ...shown,
    content: content == null ? {} : content,
  });
}

// Callers supply IDs from their authorized immutable event/publication cut.
// Never substitute current state or synthesize a missing signed create.
export async function prejoinDisplay(
  room: Room,
  ids: string[],
  member: string,
  viewer: { userId: string; tenant: Tenant },
) {
  const loaded = await room.tx(async (tx) => {
    const stay = await tx.segments.latestStay();
    return stay === null ? null : {
      version: await roomVersionOf(tx, stay.id),
      events: await selectedPrejoin(tx, ids, member),
    };
  });
  if (loaded === null) return [];
  const out: Record<string, unknown>[] = [];
  for (const source of loaded.events) {
    out.push(await shownPrejoin(room, source, loaded.version, viewer));
  }
  return out;
}

/** Saved hints are not room truth. Once a room is held, only an identified,
 * accepted source can supply unpruned content. Legacy/unidentified hints fail
 * closed using the room's redaction rules, without replacing the saved cut. */
export async function savedPrejoinDisplay(
  room: Room | null,
  saved: Record<string, unknown>[],
  member: string,
  viewer: { userId: string; tenant: Tenant },
) {
  if (room === null) return saved.map(stripPrejoin);
  const loaded = await room.tx(async (tx) => {
    const stay = await tx.segments.latestStay();
    return stay === null ? null : {
      version: await roomVersionOf(tx, stay.id),
      events: await selectedPrejoin(
        tx,
        saved.flatMap((hint) =>
          typeof hint.source_event_id === 'string' ? [hint.source_event_id] : []
        ),
        member,
      ),
    };
  });
  if (loaded === null) return saved.map(stripPrejoin);
  const sources = new Map(loaded.events.map((event) => [event.id, event]));
  const out: Record<string, unknown>[] = [];
  for (const hint of saved) {
    const source = sources.get(String(hint.source_event_id));
    out.push(
      source === undefined
        ? stripPrejoin(redact(hint, loaded.version))
        : await shownPrejoin(room, source, loaded.version, viewer, hint),
    );
  }
  return out;
}

// v3-v11 compatibility is filter-only; admin-UI warning remains a TODO.
// v12 identity comes from the signed create and cannot be guessed from hints.
export async function validatePrejoin(
  raw: unknown,
  roomId: string,
  version: string,
  keys: KeyResolver,
) {
  if (
    !Array.isArray(raw) || raw.length > 64 ||
    new TextEncoder().encode(JSON.stringify(raw)).length > 262144
  ) {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid prejoin state');
  }
  const display: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let create = false;
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const entry = structuredClone(item) as Record<string, unknown>;
    if (
      typeof entry.type !== 'string' || typeof entry.state_key !== 'string' ||
      typeof entry.sender !== 'string' || entry.content === null ||
      typeof entry.content !== 'object' || Array.isArray(entry.content)
    ) continue;
    const key = entry.type + '\0' + entry.state_key;
    if (seen.has(key)) continue;
    if (entry.type === 'm.room.create') {
      try {
        if (
          entry.state_key !== '' ||
          (entry.content as Record<string, unknown>).room_version !== version ||
          (version !== '12' && entry.room_id !== roomId)
        ) throw new Error('wrong create identity');
        await verify(entry as unknown as Pdu, version, keys, { roomId });
        create = true;
      } catch {
        if (version === '12') {
          throw new MatrixError(400, 'M_BAD_JSON', 'invalid prejoin create');
        }
        continue;
      }
    }
    seen.add(key);
    // Keep computed provenance privately. A remote-supplied event ID or hint
    // metadata is never trusted, and stripPrejoin removes this on every wire.
    let source: string | undefined;
    if (Array.isArray(entry.auth_events) && Array.isArray(entry.prev_events)) {
      try {
        source =
          (await identify(structuredClone(entry) as unknown as Pdu, version, {
            roomId,
          })).eventId;
      } catch {
        // Legacy stripped hints remain display-only, with no claimed identity.
      }
    }
    display.push({
      ...stripPrejoin(entry),
      ...(source === undefined ? {} : { source_event_id: source }),
    });
  }
  if (version === '12' && !create) {
    throw new MatrixError(400, 'M_BAD_JSON', 'prejoin create required');
  }
  return display;
}
