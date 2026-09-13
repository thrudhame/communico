import { assert, assertEquals, assertMatch, assertRejects, assertThrows } from '@std/assert';
import { serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  checkLocalpart,
  completeUiaStages,
  createUiaSession,
  dropUiaSession,
  ensureTenant,
  getTenantKey,
  getUiaSession,
  hashPassword,
  issueToken,
  lookupToken,
  nativeNameFor,
  registerUser,
  revokeAllTokens,
  revokeToken,
  tenantDbName,
  verifyPassword,
  verifyUserPassword,
} from '#engine/tenant.ts';
import { b64decode } from '#engine/signing-primitives.js';

const PHC_RE = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[^$]+\$[^$]+$/;

Deno.test('tenant: key generate-once, native name shape', async () => {
  const a = await ensureTenant(serverName());
  const b = await ensureTenant(serverName());
  assertEquals(a.key.publicB64, b.key.publicB64, 'restart must not rotate');
  assertEquals(a.dbName, await tenantDbName(serverName()));
  assertMatch(a.key.nativeName, /^[a-z2-7]{52}$/);
  assertEquals(a.key.nativeName, nativeNameFor(b64decode(a.key.publicB64)));
  const k = await getTenantKey(serverName());
  assertEquals(k.publicB64, a.key.publicB64);
});

Deno.test('credentials: argon2id PHC shape, verify good/bad', async () => {
  const phc = hashPassword('demo-password');
  assertMatch(phc, PHC_RE);
  assert(verifyPassword(phc, 'demo-password'));
  assert(!verifyPassword(phc, 'wrong'));
  assert(!verifyPassword('garbage', 'demo-password'));
});

Deno.test('localpart: downcase + spec grammar', () => {
  assertEquals(checkLocalpart('Alice'), 'alice');
  assertEquals(checkLocalpart('a=b_c.d-e/f+g'), 'a=b_c.d-e/f+g');
  assertThrows(() => checkLocalpart('al ice'), MatrixError);
  assertThrows(() => checkLocalpart('al!ce'), MatrixError);
  assertThrows(() => checkLocalpart(''), MatrixError);
});

Deno.test('register/login/token lifecycle', async () => {
  const lp = 'f1user';
  // clean slate for reruns
  const { dbName } = await ensureTenant(serverName());
  const { withDb } = await import('#engine/db.ts');
  await withDb(dbName, async (c) => {
    await c.query('DELETE FROM access_tokens WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM credentials WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM devices WHERE localpart = $1;', [lp]);
    await c.query('DELETE FROM users WHERE localpart = $1;', [lp]);
  });

  const reg = await registerUser(serverName(), {
    localpart: 'F1User',
    password: 's3cret-pw',
  });
  assertEquals(reg.user_id, `@f1user:${serverName()}`);
  assertEquals(reg.home_server, serverName());
  assert(reg.access_token && reg.access_token.length > 0);
  assert(reg.device_id.length > 0);

  // duplicate → M_USER_IN_USE
  const dup = await assertRejects(
    () => registerUser(serverName(), { localpart: lp, password: 'x' }),
    MatrixError,
  );
  assert(dup.message.includes('M_USER_IN_USE'));

  // password verify + token lookup
  assert(await verifyUserPassword(serverName(), lp, 's3cret-pw'));
  assert(!await verifyUserPassword(serverName(), lp, 'nope'));
  assert(!await verifyUserPassword(serverName(), 'nosuchuser', 's3cret-pw'));
  const info = await lookupToken(serverName(), reg.access_token!);
  assertEquals(info?.user_id, `@f1user:${serverName()}`);

  // logout one token, then all (tokens live on separate devices, as
  // separate logins do — revoking one device leaves the other standing)
  const t2 = await issueToken(serverName(), lp, 'f1user-second-device');
  await revokeToken(serverName(), t2);
  assertEquals(await lookupToken(serverName(), t2), null);
  assert((await lookupToken(serverName(), reg.access_token!)) !== null);
  await revokeAllTokens(serverName(), lp);
  assertEquals(await lookupToken(serverName(), reg.access_token!), null);
});

Deno.test('uia sessions: create/complete/drop', async () => {
  const s = await createUiaSession(serverName(), [{ stages: ['m.login.dummy'] }]);
  assert(s.session.length > 0);
  assertEquals((await getUiaSession(serverName(), s.session))?.completed, []);
  const s2 = await completeUiaStages(serverName(), s.session, ['m.login.dummy']);
  assert(s2.completed.includes('m.login.dummy'));
  await dropUiaSession(serverName(), s.session);
  assertEquals(await getUiaSession(serverName(), s.session), null);
  assertEquals(await getUiaSession(serverName(), 'no-such-session'), null);
});
