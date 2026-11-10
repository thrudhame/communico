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
      orderKeys: (ids: string[]) =>
        Promise.resolve(
          new Map(ids.map((id) => [id, {
            height:
              ({ a: 1, x: 2, bridge: 3, z: 4, y: 1 } as Record<string, number>)[
                id
              ],
            segment: 1,
            offset: positions.indexOf(id),
          }])),
        ),
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

Deno.test('room order: two nearby candidates after a 200000-event prefix use indexed keys, not ancestral reads', async () => {
  let reads = 0;
  const tx = {
    events: {
      prevsOf: (id: string) => {
        reads++;
        return Promise.resolve(
          Number(id) === 0 ? [] : [String(Number(id) - 1)],
        );
      },
      orderKeys: (ids: string[]) => {
        reads++;
        return Promise.resolve(
          new Map(
            ids.map((
              id,
            ) => [id, {
              height: Number(id) + 1,
              segment: 1,
              offset: Number(id),
            }]),
          ),
        );
      },
    },
    segments: {
      positionOf: (id: string) =>
        Promise.resolve({ segment: 1, offset: Number(id) }),
    },
  } as unknown as RoomTx;
  assertEquals(await stableCausalOrder(tx, ['200000', '199999']), [
    '199999',
    '200000',
  ]);
  assertEquals(reads, 1);
});

Deno.test('room order: wide relation sets use one key batch and no DAG traversal', async () => {
  let reads = 0;
  const ids = Array.from({ length: 400 }, (_, n) => '$' + n);
  const tx = {
    events: {
      orderKeys: (wanted: string[]) => {
        reads++;
        return Promise.resolve(
          new Map(
            wanted.map((
              id,
            ) => [id, { height: 2, segment: 1, offset: Number(id.slice(1)) }]),
          ),
        );
      },
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
  assertEquals(reads, 1);
});
