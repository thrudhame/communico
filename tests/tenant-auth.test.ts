// tests/tenant-auth.test.ts — tokens (issue/lookup/revoke), refresh
// rotation and the six UIA rules (old tenant.test.ts "uia sessions", all
// of uia.test.ts, and the engine-observable part of refresh-token.test.ts;
// its wire half stays with stage 5).
import { assert, assertEquals, assertNotEquals } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, type Tenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  issueToken,
  lookupToken,
  REFRESH_LIFETIME_MS,
} from '#engine/tenant/auth.ts';
import { registerUser } from '#engine/tenant/users.ts';
import {
  completeUiaStages,
  createUiaSession,
  dropUiaSession,
  DUMMY_FLOWS,
  getUiaSession,
  PASSWORD_FLOWS,
  requireUia,
} from '#engine/tenant/uia.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withTenant(
  fn: (tenant: Tenant) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    await fn(await openTenant(store, 'a.test', { create: true }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('tokens: issue, lookup, expiry recorded, unknown → null', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'tok', password: 'pw' });
    const plain = await issueToken(tenant, 'tok', 'dev-plain');
    const expiring = await issueToken(tenant, 'tok', 'dev-exp', 123456789);
    assertNotEquals(plain, expiring);
    const info = await lookupToken(tenant, expiring);
    assertEquals(info?.user_id, '@tok:a.test');
    assertEquals(info?.device_id, 'dev-exp');
    assertEquals(info?.expires_ms, 123456789);
    assertEquals((await lookupToken(tenant, plain))?.expires_ms, null);
    assertEquals(await lookupToken(tenant, 'not-a-token'), null);
  });
});

Deno.test('refresh rotation: old access revoked, old refresh consumed, same device', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'rt',
      password: 'pw',
    });
    const refresh1 = await issueRefreshToken(
      tenant,
      'rt',
      reg.device_id,
      reg.access_token!,
    );
    const rotated = await consumeRefreshToken(tenant, refresh1);
    assertNotEquals(rotated.accessToken, reg.access_token);
    assertNotEquals(rotated.refreshToken, refresh1);
    assertEquals(rotated.expiresInMs, REFRESH_LIFETIME_MS);
    // the OLD access token is revoked; the OLD refresh token is consumed
    assertEquals(await lookupToken(tenant, reg.access_token!), null);
    const reuse = await consumeRefreshToken(tenant, refresh1).then(
      () => null,
      (e) => e,
    );
    assert(reuse instanceof MatrixError);
    assertEquals(reuse.status, 401);
    assertEquals(reuse.errcode, 'M_UNKNOWN_TOKEN');
    // the new pair works, on the SAME device
    const info = await lookupToken(tenant, rotated.accessToken);
    assertEquals(info?.user_id, '@rt:a.test');
    assertEquals(info?.device_id, reg.device_id);
    assert(info !== null && info.expires_ms !== null);
    assert(info.expires_ms > Date.now());
    // a bogus refresh token → 401 M_UNKNOWN_TOKEN
    const bogus = await consumeRefreshToken(tenant, 'nope').then(
      () => null,
      (e) => e,
    );
    assert(bogus instanceof MatrixError);
    assertEquals(bogus.errcode, 'M_UNKNOWN_TOKEN');
    // the new refresh token rotates once more
    const again = await consumeRefreshToken(tenant, rotated.refreshToken);
    assert((await lookupToken(tenant, again.accessToken)) !== null);
  });
});

Deno.test('uia sessions: create/complete/drop', async () => {
  await withTenant(async (tenant) => {
    const s = await createUiaSession(tenant, [{
      stages: ['m.login.dummy'],
    }]);
    assert(s.session.length > 0);
    assertEquals((await getUiaSession(tenant, s.session))?.completed, []);
    const s2 = await completeUiaStages(tenant, s.session, [
      'm.login.dummy',
    ]);
    assert(s2.completed.includes('m.login.dummy'));
    await dropUiaSession(tenant, s.session);
    assertEquals(await getUiaSession(tenant, s.session), null);
    assertEquals(await getUiaSession(tenant, 'no-such-session'), null);
  });
});

/** Await a requireUia that must throw; hand back the MatrixError. */
async function uiaError(promise: Promise<void>): Promise<MatrixError> {
  try {
    await promise;
  } catch (e) {
    assert(e instanceof MatrixError, `expected MatrixError, got: ${e}`);
    return e;
  }
  throw new Error('requireUia returned; expected a throw');
}

Deno.test('rule 2: no auth.type → 401 with EXACTLY {flows, params, session} — no errcode', async () => {
  await withTenant(async (tenant) => {
    const err = await uiaError(
      requireUia(tenant, { body: {}, flows: DUMMY_FLOWS }),
    );
    assertEquals(err.status, 401);
    const body = err.responseBody();
    assertEquals(Object.keys(body).sort(), ['flows', 'params', 'session']);
    assertEquals(body.params, {});
    assertEquals(typeof body.session, 'string');
    assertEquals(body.flows, DUMMY_FLOWS);
  });
});

Deno.test('rule 1: a non-object auth is ignored; a top-level body.session is honored', async () => {
  await withTenant(async (tenant) => {
    const err = await uiaError(requireUia(tenant, {
      body: { auth: 'garbage' },
      flows: DUMMY_FLOWS,
    }));
    const session = err.responseBody().session as string;
    // Completes via the top-level session fallback (auth carries no session).
    await requireUia(tenant, {
      body: { session, auth: { type: 'm.login.dummy' } },
      flows: DUMMY_FLOWS,
    });
  });
});

Deno.test('rule 3 + the register exception: caller-less UIA requires a session — one-shot dummy gets a fresh-session 401, then the session completes', async () => {
  await withTenant(async (tenant) => {
    // Register (no caller) never one-shots: Complement TestRegistration
    // "Registration without a session fails" requires the 401 once the
    // server issues sessions. The 401 body is the rule-2 three-key shape.
    const err = await uiaError(requireUia(tenant, {
      body: { auth: { type: 'm.login.dummy' } },
      flows: DUMMY_FLOWS,
    }));
    assertEquals(err.status, 401);
    const body = err.responseBody();
    assertEquals(Object.keys(body).sort(), ['flows', 'params', 'session']);
    // Rule 3: the issued session + dummy completes the flow.
    await requireUia(tenant, {
      body: {
        auth: { type: 'm.login.dummy', session: body.session as string },
      },
      flows: DUMMY_FLOWS,
    });
  });
});

Deno.test('rule 4: caller mismatch → 403 BEFORE any password verification', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'u4alice', password: 'pw-u4a' });
    // @u4nobody does not exist: were the password checked first this could
    // only be a 401-invalid; the caller check must fire first → 403 (A1
    // :201-257 — never leak whether another user's password was right).
    const err = await uiaError(requireUia(tenant, {
      caller: '@u4alice:a.test',
      flows: PASSWORD_FLOWS,
      body: {
        auth: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: '@u4nobody:a.test' },
          password: 'whatever',
        },
      },
    }));
    assertEquals(err.status, 403);
    assertEquals(err.errcode, 'M_FORBIDDEN');
  });
});

Deno.test('rule 4: wrong password → 401 M_FORBIDDEN with {errcode,error,flows,params,session,completed:[]}', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'u4bob', password: 'pw-u4b' });
    const err = await uiaError(requireUia(tenant, {
      caller: '@u4bob:a.test',
      flows: PASSWORD_FLOWS,
      body: {
        auth: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'u4bob' }, // bare localpart
          password: 'WRONG',
        },
      },
    }));
    assertEquals(err.status, 401);
    assertEquals(err.errcode, 'M_FORBIDDEN');
    const body = err.responseBody();
    assertEquals(body.errcode, 'M_FORBIDDEN');
    assertEquals(typeof body.error, 'string');
    assertEquals(body.flows, PASSWORD_FLOWS);
    assertEquals(body.params, {});
    assertEquals(typeof body.session, 'string');
    assertEquals(body.completed, []);
  });
});

Deno.test('rule 4+6: right password one-shot (bare localpart identifier) completes', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'u4carol', password: 'pw-u4c' });
    await requireUia(tenant, {
      caller: '@u4carol:a.test',
      flows: PASSWORD_FLOWS,
      body: {
        auth: {
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: 'u4carol' },
          password: 'pw-u4c',
        },
      },
    });
  });
});

Deno.test('rule 5: partial completion → 401 carrying completed; finishing the flow returns', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'u4dave', password: 'pw-u4d' });
    const flows = [{ stages: ['m.login.dummy', 'm.login.password'] }];
    const err = await uiaError(requireUia(tenant, {
      caller: '@u4dave:a.test',
      flows,
      body: { auth: { type: 'm.login.dummy' } },
    }));
    assertEquals(err.status, 401);
    const body = err.responseBody();
    assertEquals(body.completed, ['m.login.dummy']);
    const session = body.session as string;
    // Completion = some flow's stages ⊆ completed — the second stage finishes it.
    await requireUia(tenant, {
      caller: '@u4dave:a.test',
      flows,
      body: {
        auth: {
          type: 'm.login.password',
          session,
          identifier: { type: 'm.id.user', user: 'u4dave' },
          password: 'pw-u4d',
        },
      },
    });
  });
});
