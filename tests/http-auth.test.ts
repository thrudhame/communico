import { assertEquals } from '@std/assert';
import { serverName } from '#engine/config.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { revokeToken } from '#engine/tenant/auth.ts';
import { startHttp } from '#tests/http-app.ts';

Deno.test('HTTP authentication: placement, token sources, tenant/user/device, revocation', async () => {
  const h = await startHttp(['tests/fixtures/http-auth/']);
  const call = (path = '/', headers: HeadersInit = {}) =>
    h.matrix(new Request('http://x' + path, { headers }));
  try {
    const missing = await call('/missing');
    assertEquals(missing.status, 401);
    assertEquals(missing.headers.get('access-control-allow-origin'), '*');
    assertEquals(await missing.json(), {
      errcode: 'M_MISSING_TOKEN',
      error: 'no Bearer token',
    });
    const unknown = await call('/', { Authorization: 'Bearer unknown' });
    assertEquals(unknown.status, 401);
    assertEquals(await unknown.json(), {
      errcode: 'M_UNKNOWN_TOKEN',
      error: 'token not recognized',
    });
    const user = await h.registerTestUser('auth-http', 'pw');
    for (const source of ['header', 'query']) {
      const response = await call(
        source === 'query' ? `/?access_token=${user.access_token}` : '/',
        source === 'header'
          ? { Authorization: `Bearer ${user.access_token}` }
          : {},
      );
      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        user: user.user_id,
        device: user.device_id,
        tenant: serverName(),
      });
    }
    const priority = await call(`/?access_token=${user.access_token}`, {
      Authorization: 'Bearer unknown',
    });
    assertEquals(priority.status, 401);
    await priority.json();
    const foreignTenant = await openTenant(h.app.store, 'foreign.test', {
      create: true,
    });
    const foreign = await registerUser(foreignTenant, {
      localpart: 'auth-http',
      password: 'pw',
    });
    const isolated = await call('/', {
      Authorization: `Bearer ${foreign.access_token}`,
    });
    assertEquals(isolated.status, 401);
    await isolated.json();
    await revokeToken(h.app.tenant, user.access_token!);
    const revoked = await call('/', {
      Authorization: `Bearer ${user.access_token}`,
    });
    assertEquals(revoked.status, 401);
    assertEquals((await revoked.json()).errcode, 'M_UNKNOWN_TOKEN');
    const options = await h.matrix(
      new Request('http://x/', {
        method: 'OPTIONS',
        headers: { 'Access-Control-Request-Method': 'GET' },
      }),
    );
    assertEquals(options.status, 204);
    await options.arrayBuffer();
  } finally {
    await h.close();
  }
});
