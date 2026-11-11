import { assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  completeUiaStages,
  createUiaSession,
  DUMMY_FLOWS,
  getUiaSession,
} from '#engine/tenant/uia.ts';

Deno.test('UIA: lookup/completion expire consistently; new admission prunes but preserves active flows at capacity', async () => {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { tenant: tenantSchema } });
  try {
    const tenant = await openTenant(store, 'uia.test', { create: true });
    const db = await store.tenant('uia.test');
    setConfigForTests({ uia: { sessionseconds: 10, maxsessions: 2 } });
    const expired = await createUiaSession(tenant, DUMMY_FLOWS);
    await db.execute('UPDATE uia_sessions SET created_ms=? WHERE session=?', [
      Date.now() - 10001,
      expired.session,
    ]);
    assertEquals(await getUiaSession(tenant, expired.session), null);
    await assertRejects(
      () => completeUiaStages(tenant, expired.session, ['m.login.dummy']),
      Error,
      'no such UIA session',
    );
    const active = await createUiaSession(tenant, DUMMY_FLOWS);
    const second = await createUiaSession(tenant, DUMMY_FLOWS);
    await assertRejects(
      () => createUiaSession(tenant, DUMMY_FLOWS),
      Error,
      'M_LIMIT_EXCEEDED',
    );
    assertEquals(
      (await completeUiaStages(tenant, active.session, ['m.login.dummy']))
        .completed,
      ['m.login.dummy'],
    );
    assertEquals((await getUiaSession(tenant, second.session))?.completed, []);
    assertEquals(
      Number((await db.query('SELECT count(*) AS n FROM uia_sessions'))[0].n),
      2,
    );
  } finally {
    setConfigForTests({});
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
