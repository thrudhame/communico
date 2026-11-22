// Full and partial send_join are representations of one pinned operation.
// This owner reads only the saved pre-state/auth pack, never current room state.
import { eventIdFor } from '#engine/eventid.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';

export async function joinResponse(
  result: Record<string, unknown>,
  version: string,
  apiVersion: 'v1' | 'v2',
  omitMembers: boolean,
): Promise<Record<string, unknown> | [number, Record<string, unknown>]> {
  const { servers_in_room, ...full } = result;
  if (apiVersion === 'v1') return [200, full];
  if (!omitMembers) return { ...full, members_omitted: false, servers_in_room };

  const state = result.state as Pdu[];
  const auth = result.auth_chain as Pdu[];
  const joining = result.event as Pdu;
  const members = state.filter((p) => p.type === 'm.room.member');
  const selected = new Set(
    state.filter((p) =>
      p.type !== 'm.room.member' || p.state_key === joining.state_key
    ),
  );
  // Synapse's partial join includes summary heroes only without name/alias.
  // Use the pinned memberships here rather than a racy current room summary.
  if (
    !state.some((p) =>
      (p.type === 'm.room.name' || p.type === 'm.room.canonical_alias') &&
      p.state_key === ''
    )
  ) {
    const others = members.filter((p) => p.state_key !== joining.state_key);
    const active = others.filter((p) =>
      p.content?.membership === 'join' || p.content?.membership === 'invite'
    );
    const heroes = (active.length
      ? active
      : others.filter((p) =>
        p.content?.membership === 'leave' || p.content?.membership === 'ban'
      )).sort((a, b) => {
        const order = (p: Pdu) =>
          p.content?.membership === 'join'
            ? 0
            : p.content?.membership === 'invite'
            ? 1
            : p.content?.membership === 'leave'
            ? 2
            : 3;
        return order(a) - order(b) || a.depth - b.depth ||
          String(a.state_key).localeCompare(String(b.state_key));
      });
    for (const hero of heroes.slice(0, 5)) {
      selected.add(hero);
    }
  }
  const partialState = state.filter((p) => selected.has(p));
  const ids = new Map<Pdu, string>();
  const events = new Map<string, Pdu>();
  for (const pdu of [...auth, ...state]) {
    const id = await eventIdFor(
      pdu as unknown as Record<string, unknown>,
      version,
    );
    ids.set(pdu, id);
    events.set(id, pdu);
  }
  const stateIds = new Set(partialState.map((p) => ids.get(p)!));
  const required = new Set<string>();
  // The submitted join can require an omitted authorizer that no returned
  // state event references. Both auth closures belong to this pinned result.
  const pending = [
    ...partialState.flatMap((p) => p.auth_events == null ? [] : p.auth_events),
    ...(joining.auth_events == null ? [] : joining.auth_events),
  ];
  while (pending.length) {
    const id = pending.pop()!;
    if (required.has(id)) continue;
    const pdu = events.get(id);
    if (pdu === undefined) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'saved join auth unavailable',
      );
    }
    required.add(id);
    pending.push(...(pdu.auth_events == null ? [] : pdu.auth_events));
  }
  return {
    ...full,
    state: partialState,
    auth_chain: auth.filter((p) =>
      required.has(ids.get(p)!) && !stateIds.has(ids.get(p)!)
    ),
    members_omitted: true,
    servers_in_room,
  };
}
