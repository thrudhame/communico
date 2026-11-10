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

/** Order through the stored prev DAG, not remote depth or a candidate-only
 * graph. The ancestry-closed graph makes order invariant under adding page
 * anchors or filtering candidates. Each vertex/edge is read once, with an
 * explicit shared budget; first-owner positions break concurrent ties. */
export async function stableCausalOrder(
  tx: RoomTx,
  ids: string[],
): Promise<string[]> {
  const wanted = new Set(ids);
  if (wanted.size < 2) return [...wanted];
  const parents = new Map<string, number>();
  const children = new Map<string, string[]>();
  const rank = new Map<string, [number, number, string]>();
  const queue = [...wanted], seen = new Set(queue);
  let remaining = 100_000;
  for (let offset = 0; offset < queue.length; offset++) {
    if (--remaining < 0) exhausted();
    const id = queue[offset];
    const prevs = [...new Set(await tx.events.prevsOf(id))];
    const pos = await tx.segments.positionOf(id);
    rank.set(id, [
      pos?.segment ?? Number.MAX_SAFE_INTEGER,
      pos?.offset ?? 0,
      id,
    ]);
    parents.set(id, prevs.length);
    for (const prev of prevs) {
      if (--remaining < 0) exhausted();
      const list = children.get(prev) ?? [];
      list.push(id);
      children.set(prev, list);
      if (!seen.has(prev)) {
        seen.add(prev);
        queue.push(prev);
      }
    }
  }
  const compare = (a: string, b: string) => {
    const x = rank.get(a)!, y = rank.get(b)!;
    return x[0] - y[0] || x[1] - y[1] ||
      (x[2] < y[2] ? -1 : x[2] === y[2] ? 0 : 1);
  };
  const heap: string[] = [];
  const push = (id: string) => {
    let i = heap.length;
    heap.push(id);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(heap[p], id) <= 0) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = id;
  };
  const pop = () => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length > 0) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (
          child + 1 < heap.length && compare(heap[child + 1], heap[child]) < 0
        ) child++;
        if (compare(last, heap[child]) <= 0) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  for (const id of queue) if (parents.get(id) === 0) push(id);
  const result: string[] = [];
  let visited = 0;
  while (heap.length > 0) {
    const id = pop();
    visited++;
    if (wanted.has(id)) result.push(id);
    for (const child of children.get(id) ?? []) {
      const left = parents.get(child)! - 1;
      parents.set(child, left);
      if (left === 0) push(child);
    }
  }
  if (visited !== queue.length) exhausted();
  return result;
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
