import { MatrixError } from '#engine/matrix-error.ts';
import type { RoomTx } from './index.ts';
import type { Pdu } from '#engine/pdu.ts';
import { precedes } from './causal.ts';

// One dependency order for held/fetched event packs. Depth is only a stable
// preference among ready events; remote depth can never precede dependencies.
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

function exhausted(): never {
  throw new MatrixError(
    503,
    'M_UNKNOWN',
    'topological order exceeds bounded history read',
  );
}

/** Globally comparable local DAG keys, not remote depth or candidate-only
 * Kahn order. Cost depends on candidates, never their ancestral room prefix.
 * Every known prev edge strictly increases height, including late parents. */
export async function stableCausalOrder(
  tx: RoomTx,
  ids: string[],
): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length < 2) return unique;
  const keys = await tx.events.orderKeys(unique);
  if (keys.size !== unique.length) exhausted();
  return unique.sort((a, b) => {
    const x = keys.get(a)!, y = keys.get(b)!;
    return x.height - y.height || x.segment - y.segment ||
      x.offset - y.offset ||
      (a < b ? -1 : a === b ? 0 : 1);
  });
}

/** Timestamp ties have no paging anchors. Meet nearby candidates from both
 * ends, preserving the existing cost contract for very old room prefixes. */
export async function causalOrder(
  tx: RoomTx,
  ids: string[],
): Promise<string[]> {
  if (ids.length < 2) return ids;
  const graph = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const rank = new Map<string, [number, number, string]>();
  const budget = { remaining: 100_000 };
  for (const id of ids) {
    graph.set(id, []);
    const pos = await tx.segments.positionOf(id);
    rank.set(id, [
      pos?.segment ?? Number.MAX_SAFE_INTEGER,
      pos?.offset ?? 0,
      id,
    ]);
  }
  for (const parent of ids) {
    for (const child of ids) {
      if (parent === child) continue;
      const related = await precedes(tx.events, parent, child, budget);
      if (related === null) exhausted();
      if (!related) continue;
      graph.get(child)!.push(parent);
      const next = children.get(parent) ?? [];
      next.push(child);
      children.set(parent, next);
    }
  }
  const compare = (a: string, b: string) => {
    const x = rank.get(a)!, y = rank.get(b)!;
    return x[0] - y[0] || x[1] - y[1] ||
      (x[2] < y[2] ? -1 : x[2] === y[2] ? 0 : 1);
  };
  const ready = ids.filter((id) => graph.get(id)!.length === 0);
  const result: string[] = [];
  while (ready.length > 0) {
    ready.sort(compare);
    const id = ready.shift()!;
    result.push(id);
    for (const child of children.get(id) ?? []) {
      const parents = graph.get(child)!;
      parents.splice(parents.indexOf(id), 1);
      if (parents.length === 0) ready.push(child);
    }
  }
  if (result.length !== ids.length) exhausted();
  return result;
}
