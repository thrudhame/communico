import { assert, assertEquals, assertRejects } from '@std/assert';
import { requireStreamDomain } from '#engine/client/positions.ts';
import { parseStreamToken } from '#engine/client/tokens.ts';
import { bindRole } from '#engine/facade/role.ts';
import { readPublicationIdentity } from '#engine/facade/ownership.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { openStore } from '#engine/store/index.ts';

Deno.test('position authority: missing binding refuses without minting; only the original home binding accepts legacy cuts; cold reopen retains the domain', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'position-authority-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  let home = await open('home');
  let edge = await open('edge');
  try {
    const missing = await assertRejects(
      async () => await requireStreamDomain(await edge.server(), null),
      MatrixError,
      'publication domain unavailable',
    );
    assertEquals(missing.status, 503);
    assertEquals(await readPublicationIdentity(await edge.server()), null);
    await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
    await bindRole(edge, {
      role: 'facade',
      server: 'logical.test',
      node: 'edge_a',
    });
    const local = await requireStreamDomain(await home.server(), null);
    const foreign = await requireStreamDomain(await edge.server(), null);
    assert(local !== foreign);
    const cuts = parseStreamToken('s1')!;
    assertEquals(await requireStreamDomain(await home.server(), cuts), local);
    const refused = await assertRejects(
      async () => await requireStreamDomain(await edge.server(), cuts),
      MatrixError,
      'foreign sync position',
    );
    assertEquals(refused.status, 400);
    await assertRejects(
      async () =>
        await requireStreamDomain(await edge.server(), {
          ...cuts,
          domain: local,
        }),
      MatrixError,
      'foreign sync position',
    );
    await home.close();
    await edge.close();
    home = await open('home');
    edge = await open('edge');
    assertEquals(
      await requireStreamDomain(await home.server(), {
        ...cuts,
        domain: local,
      }),
      local,
    );
    assertEquals(
      await requireStreamDomain(await edge.server(), {
        ...cuts,
        domain: foreign,
      }),
      foreign,
    );
  } finally {
    await home.close();
    await edge.close();
    await Deno.remove(dir, { recursive: true });
  }
});
