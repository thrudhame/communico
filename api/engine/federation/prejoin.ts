// Federation keeps full create PDUs; client display gets stripped state only.
// This data is a prejoin hint, never authoritative room auth/encryption state.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import type { Room, RoomTx } from '#engine/room/index.ts';
import { roomVersionOf } from '#engine/room/build.ts';
import { verify } from '#engine/room/verify.ts';
import { toWire } from './pdu.ts';

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
export async function prejoinStateInTx(
  tx: RoomTx,
  member: string,
): Promise<Record<string, unknown>[]> {
  const stay = await tx.segments.openStay();
  if (stay === null) return [];
  const group = await tx.state.current(stay.id);
  if (group === null) return [];
  const version = await roomVersionOf(tx, stay.id);
  const out: Record<string, unknown>[] = [];
  for (const [key, id] of await tx.state.groupMap(group)) {
    const [type, stateKey] = key.split('\0');
    if (
      !prejoinTypes.has(type) &&
      !(type === 'm.room.member' && stateKey === member)
    ) continue;
    const row = await tx.events.get(id);
    if (row === null) continue;
    const pdu = JSON.parse(row.pdu) as Pdu;
    const wire = toWire(pdu, version);
    out.push(type === 'm.room.create' ? wire : stripPrejoin(wire));
  }
  return out;
}
export function prejoinState(room: Room, member: string) {
  return room.tx((tx) => prejoinStateInTx(tx, member));
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
    display.push(stripPrejoin(entry));
  }
  if (version === '12' && !create) {
    throw new MatrixError(400, 'M_BAD_JSON', 'prejoin create required');
  }
  return display;
}
