// tests/uia.test.ts — the six rules of plan §3.3 against requireUia
// directly (live doltgres: UIA sessions and credentials are tenant rows).
// Each rule maps to a Complement assertion (§2 A1/A4/A6).
import { assert, assertEquals } from '@std/assert';
import { DUMMY_FLOWS, PASSWORD_FLOWS, requireUia } from '#engine/uia.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverName } from '#engine/config.ts';
import { registerTestUser } from './util.ts';

const SN = serverName();

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
  const err = await uiaError(
    requireUia({ serverName: SN, body: {}, flows: DUMMY_FLOWS }),
  );
  assertEquals(err.status, 401);
  const body = err.responseBody();
  assertEquals(Object.keys(body).sort(), ['flows', 'params', 'session']);
  assertEquals(body.params, {});
  assertEquals(typeof body.session, 'string');
  assertEquals(body.flows, DUMMY_FLOWS);
});

Deno.test('rule 1: a non-object auth is ignored; a top-level body.session is honored', async () => {
  const err = await uiaError(requireUia({
    serverName: SN,
    body: { auth: 'garbage' },
    flows: DUMMY_FLOWS,
  }));
  const session = err.responseBody().session as string;
  // Completes via the top-level session fallback (auth carries no session).
  await requireUia({
    serverName: SN,
    body: { session, auth: { type: 'm.login.dummy' } },
    flows: DUMMY_FLOWS,
  });
});

Deno.test('rule 3 + the register exception: caller-less UIA requires a session — one-shot dummy gets a fresh-session 401, then the session completes', async () => {
  // Register (no caller) never one-shots: Complement TestRegistration
  // "Registration without a session fails" requires the 401 once the
  // server issues sessions. The 401 body is the rule-2 three-key shape.
  const err = await uiaError(requireUia({
    serverName: SN,
    body: { auth: { type: 'm.login.dummy' } },
    flows: DUMMY_FLOWS,
  }));
  assertEquals(err.status, 401);
  const body = err.responseBody();
  assertEquals(Object.keys(body).sort(), ['flows', 'params', 'session']);
  // Rule 3: the issued session + dummy completes the flow.
  await requireUia({
    serverName: SN,
    body: { auth: { type: 'm.login.dummy', session: body.session as string } },
    flows: DUMMY_FLOWS,
  });
});

Deno.test('rule 4: caller mismatch → 403 BEFORE any password verification', async () => {
  await registerTestUser('u4alice', 'pw-u4a');
  // @u4nobody does not exist: were the password checked first this could
  // only be a 401-invalid; the caller check must fire first → 403 (A1
  // :201-257 — never leak whether another user's password was right).
  const err = await uiaError(requireUia({
    serverName: SN,
    caller: `@u4alice:${SN}`,
    flows: PASSWORD_FLOWS,
    body: {
      auth: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: `@u4nobody:${SN}` },
        password: 'whatever',
      },
    },
  }));
  assertEquals(err.status, 403);
  assertEquals(err.errcode, 'M_FORBIDDEN');
});

Deno.test('rule 4: wrong password → 401 M_FORBIDDEN with {errcode,error,flows,params,session,completed:[]}', async () => {
  await registerTestUser('u4bob', 'pw-u4b');
  const err = await uiaError(requireUia({
    serverName: SN,
    caller: `@u4bob:${SN}`,
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

Deno.test('rule 4+6: right password one-shot (bare localpart identifier) completes', async () => {
  await registerTestUser('u4carol', 'pw-u4c');
  await requireUia({
    serverName: SN,
    caller: `@u4carol:${SN}`,
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

Deno.test('rule 5: partial completion → 401 carrying completed; finishing the flow returns', async () => {
  await registerTestUser('u4dave', 'pw-u4d');
  const flows = [{ stages: ['m.login.dummy', 'm.login.password'] }];
  const err = await uiaError(requireUia({
    serverName: SN,
    caller: `@u4dave:${SN}`,
    flows,
    body: { auth: { type: 'm.login.dummy' } },
  }));
  assertEquals(err.status, 401);
  const body = err.responseBody();
  assertEquals(body.completed, ['m.login.dummy']);
  const session = body.session as string;
  // Completion = some flow's stages ⊆ completed — the second stage finishes it.
  await requireUia({
    serverName: SN,
    caller: `@u4dave:${SN}`,
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
