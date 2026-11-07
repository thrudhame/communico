// One dependency order for held/fetched event packs. Depth is only a stable
// preference among ready events; remote depth can never precede dependencies.
import type { Pdu } from '#engine/pdu.ts';

export function orderEvents<T extends { eventId: string; pdu: Pdu }>(
  events: readonly T[],
  edges: readonly ('prev_events' | 'auth_events')[],
  dependencies: (event: T) => readonly string[] = () => [],
): T[] {
  const byId = new Map(events.map((event) => [event.eventId, event]));
  const pending = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const [id, item] of byId) {
    const parents = new Set(
      [...edges.flatMap((edge) => item.pdu[edge] ?? []), ...dependencies(item)]
        .filter((parent) => byId.has(parent)),
    );
    pending.set(id, parents.size);
    for (const parent of parents) {
      const list = children.get(parent) ?? [];
      list.push(id);
      children.set(parent, list);
    }
  }
  const compare = (a: string, b: string) => {
    const depth = byId.get(a)!.pdu.depth - byId.get(b)!.pdu.depth;
    return depth || (a < b ? -1 : a > b ? 1 : 0);
  };
  const ready = [...byId.keys()].filter((id) => pending.get(id) === 0).sort(
    compare,
  );
  const ordered: T[] = [];
  const done = new Set<string>();
  while (ready.length > 0) {
    const id = ready.shift()!;
    done.add(id);
    ordered.push(byId.get(id)!);
    for (const child of children.get(id) ?? []) {
      const left = pending.get(child)! - 1;
      pending.set(child, left);
      if (left === 0) {
        ready.push(child);
        ready.sort(compare);
      }
    }
  }
  // Cycles cannot establish authorization. Callers keep not-yet-checked auth
  // candidates rejected, so a cyclic remainder cannot vouch for itself.
  for (
    const id of [...byId.keys()].filter((id) => !done.has(id)).sort(compare)
  ) {
    ordered.push(byId.get(id)!);
  }
  return ordered;
}
