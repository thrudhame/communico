import { assertEquals } from '@std/assert';
import { domainOf, localpartOf, splitId } from '#engine/ids.ts';

for (
  const { name, id, localpart, server } of [
    { name: 'no colon', id: '@bob', localpart: 'bob', server: null },
    {
      name: 'port',
      id: '@bob:server.test:8448',
      localpart: 'bob',
      server: 'server.test:8448',
    },
    {
      name: 'IPv6 literal',
      id: '@a:[::1]:8448',
      localpart: 'a',
      server: '[::1]:8448',
    },
    {
      name: 'empty localpart',
      id: '@:server.test',
      localpart: '',
      server: 'server.test',
    },
  ]
) {
  Deno.test('ids: ' + name, () => {
    assertEquals(splitId(id), { localpart, server });
    assertEquals(localpartOf(id), localpart);
    assertEquals(domainOf(id), server === null ? id : server);
  });
}
