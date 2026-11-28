import { assertThrows } from '@std/assert';
import { MediaEgress } from '#engine/facade/media-egress.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { tenantSchema } from '#engine/tenant/index.ts';

Deno.test('facade media egress excludes standardized NAT64 prefixes', async (t) => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-media-egress-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  try {
    const policy = new MediaEgress(await store.server(), []);
    await t.step('well-known prefix', () => {
      assertThrows(() => policy.check('64:ff9b::'), UpstreamError);
    });
    await t.step('local-use prefix', () => {
      assertThrows(() => policy.check('64:ff9b:1::'), UpstreamError);
    });
    await t.step('ordinary public IPv6 stays allowed', () => {
      policy.check('2606:4700::');
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
