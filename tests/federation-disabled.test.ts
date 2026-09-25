// tests/federation-disabled.test.ts — enabled=false ⇒ key endpoints,
// federation routes and /.well-known are all 404; the client refuses to
// dial at all.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { federationRequest } from '#engine/federation/client.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

Deno.test('disabled: /_matrix/federation, /_matrix/key, /.well-known all 404; client refuses', async () => {
  setConfigForTests({ federation: { enabled: false } });
  const paths = [
    '/_matrix/federation/v1/version',
    '/_matrix/key/v2/server',
    '/.well-known/matrix/server',
  ];
  for (const p of paths) {
    const res = await matrix(new Request('http://x' + p));
    assertEquals(res.status, 404, `${p} must be 404 when disabled`);
  }
  const err = await federationRequest({
    destination: 'else.test',
    method: 'GET',
    path: '/x',
    body: null,
  }).then(() => 'ok', (e: unknown) => e as MatrixError);
  assert((err as MatrixError) instanceof MatrixError);
  assertEquals((err as MatrixError).status, 502);
  assert((err as MatrixError).message.includes('disabled'));
  setConfigForTests({ federation: { enabled: true } });
});
