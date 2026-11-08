// CRUD/ordering/actions/enabled and server-controlled-type assertions
// restored from doltgres:tests/pushrules.test.ts. /sync synthesis,
// long-poll wake and room upgrade/join migration return with their routes.
import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
const { matrix, registerTestUser, test } = httpSuite('HTTP push rules');
type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
) {
  const res = await matrix(
    new Request('http://x' + path, {
      method: init.method ?? 'GET',
      headers: init.token === undefined
        ? {}
        : { Authorization: `Bearer ${init.token}` },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  return { status: res.status, body: await res.json() as Json };
}

test('pushrules: CRUD + ordering + enabled/actions + server-controlled 405s', async () => {
  const alice = await registerTestUser('pr-a', 'pw-pr-a');
  const tok = alice.access_token!;
  const aId = alice.user_id;
  const rule = (kind: string, id: string) =>
    `/_matrix/client/v3/pushrules/global/${kind}/${encodeURIComponent(id)}`;
  const empty = await call('/_matrix/client/v3/pushrules/', { token: tok });
  assertEquals(empty.status, 200);
  const emptyGlobal = empty.body.global as Json;
  for (const kind of ['override', 'content', 'room', 'sender', 'underride']) {
    assertEquals((emptyGlobal[kind] as unknown[]).length, 0, kind);
  }
  const roomId = '!someroom:localhost';
  assertEquals(
    (await call(rule('room', roomId), {
      method: 'PUT',
      token: tok,
      body: { actions: ['dont_notify'] },
    })).status,
    200,
  );
  const one = await call(rule('room', roomId), { token: tok });
  assertEquals(one.status, 200);
  assertEquals(one.body.rule_id, roomId);
  assertEquals(one.body.actions, ['dont_notify']);
  assertEquals(one.body.default, false);
  assertEquals(one.body.enabled, true);
  assertEquals(
    (await call(rule('room', '!x:y'), { method: 'PUT', token: tok, body: {} }))
      .status,
    400,
  );
  const dot = await call(rule('override', '.m.rule.master'), {
    method: 'PUT',
    token: tok,
    body: { actions: ['dont_notify'] },
  });
  assertEquals(dot.status, 400);
  assertEquals(dot.body.errcode, 'M_INVALID_PARAM');
  assertEquals(
    (await call(
      `/_matrix/client/v3/pushrules/other/room/${encodeURIComponent('!x:y')}`,
      { token: tok },
    )).status,
    400,
  );
  assertEquals((await call(rule('bogus', 'x'), { token: tok })).status, 400);
  const mk = (id: string, qs = '') =>
    call(rule('override', id) + qs, {
      method: 'PUT',
      token: tok,
      body: { actions: ['notify'] },
    });
  assertEquals((await mk('ruleA')).status, 200);
  assertEquals((await mk('ruleB', '?after=ruleA')).status, 200);
  assertEquals((await mk('ruleC', '?before=ruleA')).status, 200);
  const ordered = (await call('/_matrix/client/v3/pushrules/', { token: tok }))
    .body.global as Json;
  assertEquals((ordered.override as Json[]).map((r) => r.rule_id), [
    'ruleC',
    'ruleA',
    'ruleB',
  ]);
  const noAnchor = await mk('ruleD', '?after=nope');
  assertEquals(noAnchor.status, 400);
  assertEquals(noAnchor.body.errcode, 'M_UNKNOWN');
  assertEquals(
    (await call(rule('room', roomId) + '/enabled', {
      method: 'PUT',
      token: tok,
      body: { enabled: false },
    })).status,
    200,
  );
  const en = await call(rule('room', roomId) + '/enabled', { token: tok });
  assertEquals(en.body, { enabled: false });
  assertEquals(
    (await call(rule('room', roomId) + '/actions', {
      method: 'PUT',
      token: tok,
      body: { actions: ['notify', { set_tweak: 'sound', value: 'default' }] },
    })).status,
    200,
  );
  const act = await call(rule('room', roomId) + '/actions', { token: tok });
  assertEquals(act.body.actions, ['notify', {
    set_tweak: 'sound',
    value: 'default',
  }]);
  assertEquals(
    (await call(rule('room', '!other:localhost'), {
      method: 'PUT',
      token: tok,
      body: { actions: ['dont_notify'] },
    })).status,
    200,
  );
  assertEquals(
    (await call(rule('room', '!other:localhost'), {
      method: 'DELETE',
      token: tok,
    })).status,
    200,
  );
  assertEquals(
    (await call(rule('room', '!other:localhost'), { token: tok })).status,
    404,
  );
  const g405 = await call(
    `/_matrix/client/v3/user/${
      encodeURIComponent(aId)
    }/account_data/m.push_rules`,
    { method: 'PUT', token: tok, body: { global: {} } },
  );
  assertEquals(g405.status, 405);
  assertEquals(g405.body.errcode, 'M_BAD_JSON');
  const r405 = await call(
    `/_matrix/client/v3/user/${encodeURIComponent(aId)}/rooms/${
      encodeURIComponent('!x:y')
    }/account_data/m.fully_read`,
    { method: 'PUT', token: tok, body: { event_id: '$e' } },
  );
  assertEquals(r405.status, 405);
});
