import { assertEquals } from '@std/assert';
import { precedes } from '#engine/room/causal.ts';

Deno.test('causal: skewed/transitive paths, concurrent siblings, unknown bounds and cycles', async () => {
  const parents: Record<string, string[]> = {
    root: [],
    a: ['root'],
    b: ['root'],
    mid: ['a'],
    c: ['mid'],
  };
  const graph = {
    prevsOf: (id: string) => Promise.resolve(parents[id] ?? []),
    childrenOf: (id: string) =>
      Promise.resolve(
        Object.keys(parents).filter((key) => parents[key].includes(id)),
      ),
  };
  assertEquals(await precedes(graph, 'a', 'c', { remaining: 100 }), true);
  assertEquals(await precedes(graph, 'c', 'a', { remaining: 100 }), false);
  assertEquals(await precedes(graph, 'a', 'b', { remaining: 100 }), false);
  assertEquals(await precedes(graph, 'a', 'c', { remaining: 1 }), null);
  parents.root = ['b'];
  assertEquals(
    await precedes(graph, 'a', 'missing', { remaining: 100 }),
    false,
  );
});
