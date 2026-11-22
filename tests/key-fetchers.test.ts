import { assertEquals, assertStrictEquals } from '@std/assert';
import { keyFetchers } from '#engine/federation/key-fetchers.ts';
import type { KeysDeps } from '#engine/federation/keys.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

for (const oversizedOrigin of [false, true]) {
  Deno.test(`review keys: split oversized notary answers and isolate singleton limits ${oversizedOrigin}`, async () => {
    const tooLarge = new UpstreamError('validation', {
      phase: 'http-body',
      reason: 'Content is too large',
      resourceLimit: true,
    });
    const calls: string[][] = [];
    const deps: KeysDeps = {
      listWitnesses: () => Promise.resolve(['witness.test']),
      directGet: () => {
        throw new Error('not a direct fetch');
      },
      witnessQuery: (_peer, demands) => {
        const names = Object.keys(demands);
        calls.push(names);
        if (names.length > 1 || (oversizedOrigin && names[0] === 'b.test')) {
          throw tooLarge;
        }
        return Promise.resolve({ server_keys: [{ server_name: names[0] }] });
      },
    };
    const fetchers = keyFetchers();
    const results = await Promise.allSettled(
      ['a.test', 'b.test'].map((name) =>
        fetchers.witness({
          name,
          peer: 'witness.test',
          horizon: 123,
          deps,
        })
      ),
    );
    assertEquals(results[0], {
      status: 'fulfilled',
      value: { server_keys: [{ server_name: 'a.test' }] },
    });
    if (oversizedOrigin) {
      assertEquals(results[1].status, 'rejected');
      if (results[1].status === 'rejected') {
        assertStrictEquals(results[1].reason, tooLarge);
      }
    } else {
      assertEquals(results[1], {
        status: 'fulfilled',
        value: { server_keys: [{ server_name: 'b.test' }] },
      });
    }
    assertEquals(calls, [['a.test', 'b.test'], ['a.test'], ['b.test']]);
  });
}
