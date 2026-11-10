// One serve-time erasure policy for user and server principals. The retained
// publication boundary preserves visibility already acquired before erasure,
// including shared history and world-readable events, not just event-time joins.
import type { Room, RoomTx } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { domainOf } from '#engine/federation/pdu.ts';
import { erasureFor } from '#engine/tenant/erasure.ts';
import { redact } from '#engine/eventid.ts';

import type { ErasureCut } from '#engine/room/state.ts';
export type ErasurePrincipal = { userId: string } | { server: string };

async function priorVisibility(
  tx: RoomTx,
  eventId: string,
  cut: ErasureCut,
  principal?: ErasurePrincipal,
): Promise<boolean> {
  const refs = await tx.state.eventReadState(eventId);
  if (refs === null) return false;
  const row = await tx.events.get(eventId);
  const groups = [refs.after.group];
  if (row?.type === 'm.room.history_visibility') groups.push(refs.before.group);
  const member = async (group: number, invited: boolean) => {
    if (principal === undefined) return false;
    const keys = 'userId' in principal
      ? [principal.userId]
      : [...(await tx.state.groupMap(group)).keys()]
        .filter((key) =>
          key.startsWith('m.room.member\0') &&
          domainOf(key.slice(14)) === principal.server
        )
        .map((key) => key.slice(14));
    for (const user of keys) {
      const id = await tx.state.groupKey(group, 'm.room.member', user);
      const event = id === null ? null : await tx.events.get(id);
      const membership = event === null
        ? null
        : JSON.parse(event.pdu).content?.membership;
      if (membership === 'join' || (invited && membership === 'invite')) {
        return true;
      }
    }
    return false;
  };
  let shared = false;
  for (const group of groups) {
    if (group > cut.group) continue;
    const id = await tx.state.groupKey(group, 'm.room.history_visibility', '');
    const visibilityRow = id === null ? null : await tx.events.get(id);
    const visibility = visibilityRow === null
      ? 'shared'
      : JSON.parse(visibilityRow.pdu).content?.history_visibility;
    if (
      visibility === 'world_readable' ||
      await member(group, visibility === 'invited')
    ) return true;
    if (!['joined', 'invited', 'world_readable'].includes(String(visibility))) {
      shared = true;
    }
  }
  if (shared) {
    for (const group of await tx.state.publishedGroupsAfter(eventId, cut)) {
      if (await member(group, false)) return true;
    }
  }
  return false;
}

export async function erasurePrunes(
  room: Room,
  eventId: string,
  pdu: Pdu,
  principal?: ErasurePrincipal,
  tenant?: Tenant,
  heldTx?: RoomTx,
): Promise<boolean> {
  const cut = await erasureFor(room.store, pdu.sender, room.id, tenant);
  if (cut === false) return false;
  if (cut === null) return true;
  return !(heldTx === undefined
    ? await room.tx((tx) => priorVisibility(tx, eventId, cut, principal))
    : await priorVisibility(heldTx, eventId, cut, principal));
}

export async function erasedView(
  room: Room,
  eventId: string,
  pdu: Pdu,
  version: string,
  principal?: ErasurePrincipal,
  tenant?: Tenant,
  tx?: RoomTx,
): Promise<Pdu> {
  return await erasurePrunes(room, eventId, pdu, principal, tenant, tx)
    ? redact(
      pdu as unknown as Record<string, unknown>,
      version,
    ) as unknown as Pdu
    : pdu;
}
