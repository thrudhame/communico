import { assertEquals } from '@std/assert';
import type { RoomTx } from '#engine/room/index.ts';
import { stableCausalOrder } from '#engine/room/order.ts';

Deno.test('room order: adding a page anchor cannot reorder candidates across an unselected ancestor', async () => {
  const prevs: Record<string, string[]> = {
    a: [],
    x: ['a'],
    bridge: ['x'],
    z: ['bridge'],
    y: [],
  };
  const positions = ['x', 'y', 'a', 'bridge', 'z'];
  const tx = {
    events: {
      prevsOf: (id: string) => Promise.resolve(prevs[id] ?? []),
      childrenOf: (id: string) =>
        Promise.resolve(
          Object.keys(prevs).filter((key) => prevs[key].includes(id)),
        ),
    },
    segments: {
      positionOf: (id: string) =>
        Promise.resolve({
          segment: 1,
          offset: positions.indexOf(id),
        }),
    },
  } as unknown as RoomTx;
  const subset = await stableCausalOrder(tx, ['x', 'y', 'z']);
  const anchored = await stableCausalOrder(tx, ['a', 'x', 'y', 'z']);
  assertEquals(anchored.filter((id) => id !== 'a'), subset);
  assertEquals(subset.indexOf('x') < subset.indexOf('z'), true);
});

Deno.test('room order: wide relation sets read each DAG vertex once, not each pair', async () => {
  let reads = 0;
  const ids = Array.from({ length: 400 }, (_, n) => '$' + n);
  const tx = {
    events: {
      prevsOf: (id: string) => {
        reads++;
        return Promise.resolve(id === '$root' ? [] : ['$root']);
      },
    },
    segments: {
      positionOf: (id: string) =>
        Promise.resolve({
          segment: 1,
          offset: id === '$root' ? -1 : Number(id.slice(1)),
        }),
    },
  } as unknown as RoomTx;
  assertEquals(await stableCausalOrder(tx, [...ids].reverse()), ids);
  assertEquals(reads, 401);
});
