// A proved prev-DAG relation, independent of arrival positions, timestamps and
// remote depth. Meet from both ends, expanding the smaller frontier: nearby
// events never require the room's entire ancestral prefix. Null is unknown at
// the shared read budget, never evidence of order or permission.
export type CausalGraph = {
  prevsOf(id: string): Promise<string[]>;
  childrenOf(id: string): Promise<string[]>;
};
export type CausalBudget = { remaining: number };

export async function precedes(
  graph: CausalGraph,
  ancestor: string,
  descendant: string,
  budget: CausalBudget,
): Promise<boolean | null> {
  if (--budget.remaining < 0) return null;
  if (ancestor === descendant) return true;
  const seen = [new Set([ancestor]), new Set([descendant])];
  const queues = [[ancestor], [descendant]];
  const offsets = [0, 0];
  let turn = 0;
  while (offsets[0] < queues[0].length && offsets[1] < queues[1].length) {
    const sizes = queues.map((q, i) => q.length - offsets[i]);
    const side = sizes[0] === sizes[1]
      ? turn++ % 2
      : sizes[0] < sizes[1]
      ? 0
      : 1;
    if (--budget.remaining < 0) return null;
    const id = queues[side][offsets[side]++];
    const edges = side === 0
      ? await graph.childrenOf(id)
      : await graph.prevsOf(id);
    for (const next of edges) {
      if (seen[1 - side].has(next)) return true;
      if (seen[side].has(next)) continue;
      if (--budget.remaining < 0) return null;
      seen[side].add(next);
      queues[side].push(next);
    }
  }
  return false;
}
