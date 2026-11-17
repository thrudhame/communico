import { assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { loginUser, registerUser } from '#engine/tenant/users.ts';
import {
  activateTenantAuthority,
  captureSessionAuthority,
  installSessionAuthority,
} from '#engine/tenant/session-authority.ts';

Deno.test('HTTP F2 key pools: C-S consumes available owner keys and reports a missing owner without false exhaustion', async () => {
  const f = await startHttp();
  try {
    const user = await f.registerTestUser('claim-owner', 'pw');
    const local = await f.app.store.tenant(f.app.tenant.serverName);
    const common = {
      homeIncarnation: 'home-store',
      edgeNode: 'edge',
      edgeIncarnation: 'edge-store',
    };
    await local.tx((conn) =>
      activateTenantAuthority(conn, {
        ...common,
        node: 'home',
        incarnation: 'home-store',
      })
    );
    const foreign = await openTenant(f.app.store, 'edge-pools.test', {
      create: true,
    });
    await registerUser(foreign, {
      localpart: 'claim-owner',
      password: 'pw',
      accessToken: null,
    });
    const other = await f.app.store.tenant(foreign.serverName);
    await other.tx((conn) =>
      activateTenantAuthority(conn, {
        ...common,
        node: 'edge',
        incarnation: 'edge-store',
      })
    );
    await loginUser(foreign, {
      localpart: 'claim-owner',
      password: 'pw',
      deviceId: 'FOREIGN',
      refresh: false,
    });
    const view = await other.tx((conn) =>
      captureSessionAuthority(conn, 'claim-owner')
    );
    await local.tx((conn) =>
      installSessionAuthority(conn, 'claim-owner', view)
    );
    const post = async (path: string, body: unknown) => {
      const response = await f.matrix(
        new Request(
          'http://x/_matrix/client/v3/keys/' + path,
          {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + user.access_token },
            body: JSON.stringify(body),
          },
        ),
      );
      assertEquals(response.status, 200, await response.clone().text());
      return await response.json();
    };
    await post('upload', { one_time_keys: { 'curve25519:once': 'once' } });
    assertEquals(
      await post('claim', {
        one_time_keys: {
          [user.user_id]: {
            [user.device_id]: 'curve25519',
            FOREIGN: 'curve25519',
          },
        },
      }),
      {
        one_time_keys: {
          [user.user_id]: { [user.device_id]: { 'curve25519:once': 'once' } },
        },
        failures: {
          [f.app.tenant.serverName]: {
            errcode: 'M_UNAVAILABLE',
            error: 'keys unavailable',
          },
        },
      },
    );
  } finally {
    await f.close();
  }
});
