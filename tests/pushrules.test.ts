// tests/pushrules.test.ts — the push-rules module (plan D9/D10): CRUD,
// /enabled, /actions, before/after ordering, the .-prefix reject,
// m.push_rules synthesised into initial + incremental sync, the
// account-data stream (long-poll wake + band-C's incremental delivery
// fix), and the server-controlled-type 405s. Live doltgres, HTTP-level
// via the real endpoint trees.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await matrix(
    new Request(`http://x${path}`, {
      method: init.method ?? 'GET',
      headers,
      body,
    }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

const sync = (token: string, query = '') =>
  call(`/_matrix/client/v3/sync?timeout=0${query}`, { token });

Deno.test('pushrules: CRUD + ordering + enabled/actions + sync synthesis + stream + 405s', async () => {
  const alice = await registerTestUser('pr-a', 'pw-pr-a');
  const tok = alice.access_token!;
  const aId = alice.user_id as string;
  const rule = (kind: string, id: string) =>
    `/_matrix/client/v3/pushrules/global/${kind}/${encodeURIComponent(id)}`;

  // GET /pushrules/ (trailing slash, the spec path) — empty kinds present
  const empty = await call('/_matrix/client/v3/pushrules/', { token: tok });
  assertEquals(empty.status, 200);
  const emptyGlobal = empty.body.global as Json;
  for (const kind of ['override', 'content', 'room', 'sender', 'underride']) {
    assertEquals((emptyGlobal[kind] as unknown[]).length, 0, kind);
  }

  // PUT a room rule → it lands with default:false, enabled:true
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

  // actions required on PUT
  assertEquals(
    (await call(rule('room', '!x:y'), {
      method: 'PUT',
      token: tok,
      body: {},
    })).status,
    400,
  );
  // .-prefixed rule ids are reserved → 400 M_INVALID_PARAM
  const dot = await call(rule('override', '.m.rule.master'), {
    method: 'PUT',
    token: tok,
    body: { actions: ['dont_notify'] },
  });
  assertEquals(dot.status, 400);
  assertEquals(dot.body.errcode, 'M_INVALID_PARAM');
  // bad scope / kind → 400
  assertEquals(
    (await call(
      `/_matrix/client/v3/pushrules/other/room/${encodeURIComponent('!x:y')}`,
      { token: tok },
    )).status,
    400,
  );
  assertEquals(
    (await call(rule('bogus', 'x'), { token: tok })).status,
    400,
  );

  // before/after ordering: base rule A; B after A; C before A → C, A, B
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
  assertEquals(
    (ordered.override as Json[]).map((r) => r.rule_id),
    ['ruleC', 'ruleA', 'ruleB'],
  );
  // before/after with an unknown anchor → 400 M_UNKNOWN
  const noAnchor = await mk('ruleD', '?after=nope');
  assertEquals(noAnchor.status, 400);
  assertEquals(noAnchor.body.errcode, 'M_UNKNOWN');

  // /enabled round-trip
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
  // /actions round-trip
  assertEquals(
    (await call(rule('room', roomId) + '/actions', {
      method: 'PUT',
      token: tok,
      body: { actions: ['notify', { set_tweak: 'sound', value: 'default' }] },
    })).status,
    200,
  );
  const act = await call(rule('room', roomId) + '/actions', { token: tok });
  assertEquals(act.body.actions, [
    'notify',
    { set_tweak: 'sound', value: 'default' },
  ]);

  // m.push_rules: initial sync ALWAYS carries it; incremental carries it
  // after a mutation (D10) — and the long-poll wakes on the stream
  const initial = await sync(tok);
  const ad0 = (initial.body.account_data as Json).events as Json[];
  const pr0 = ad0.find((e) => e.type === 'm.push_rules');
  assert(pr0 !== undefined, 'm.push_rules in initial sync');
  assertEquals(
    ((pr0!.content as Json).global as Json).room as Json[],
    [{
      rule_id: roomId,
      actions: ['notify', { set_tweak: 'sound', value: 'default' }],
      default: false,
      enabled: false,
    }],
  );

  const since = initial.body.next_batch as string;
  assert(/^s\d+_p\d+_t\d+_r\d+_a\d+$/.test(since), since);
  // a plain account-data write lands incrementally too (band-C fix)
  assertEquals(
    (await call(
      `/_matrix/client/v3/user/${
        encodeURIComponent(aId)
      }/account_data/com.example.custom`,
      { method: 'PUT', token: tok, body: { hello: 'world' } },
    )).status,
    200,
  );
  const inc = await sync(tok, `&since=${encodeURIComponent(since)}`);
  const ad1 = (inc.body.account_data as Json).events as Json[];
  assert(
    ad1.some((e) => e.type === 'com.example.custom'),
    'changed account data delivered incrementally',
  );

  // long-poll wake: a waiting sync returns when a rule is written
  const waiting = call(
    `/_matrix/client/v3/sync?timeout=5000&since=${
      encodeURIComponent((await sync(tok)).body.next_batch as string)
    }`,
    { token: tok },
  );
  await new Promise((r) => setTimeout(r, 250));
  assertEquals(
    (await call(rule('room', '!other:localhost'), {
      method: 'PUT',
      token: tok,
      body: { actions: ['dont_notify'] },
    })).status,
    200,
  );
  const woken = await waiting;
  const ad2 = (woken.body.account_data as Json).events as Json[];
  const pr2 = ad2.find((e) => e.type === 'm.push_rules');
  assert(pr2 !== undefined, 'long-poll woke on the push-rule stream');
  assertEquals(
    (((pr2!.content as Json).global as Json).room as Json[]).length,
    2,
  );

  // delete → 200; gone afterwards; the stream still moves
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
  const afterDelete = await sync(
    tok,
    `&since=${encodeURIComponent(woken.body.next_batch as string)}`,
  );
  const ad3 = (afterDelete.body.account_data as Json).events as Json[];
  assert(
    ad3.some((e) => e.type === 'm.push_rules'),
    'a delete that empties the table still moves the stream',
  );

  // server-controlled types are 405 on both account_data endpoints
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

Deno.test('pushrules migration: /upgrade, manual tombstone+predecessor, and the join hook (D8)', async () => {
  const alice = await registerTestUser('pm-a', 'pw-pm-a');
  const alice2 = await registerTestUser('pm-b', 'pw-pm-b');
  const carol = await registerTestUser('pm-c', 'pw-pm-c');
  const aTok = alice.access_token!;
  const a2Tok = alice2.access_token!;
  const cTok = carol.access_token!;

  const roomRule = (tok: string, roomId: string) =>
    call(
      `/_matrix/client/v3/pushrules/global/room/${encodeURIComponent(roomId)}`,
      {
        method: 'PUT',
        token: tok,
        body: { actions: ['dont_notify'] },
      },
    );
  const roomRuleIds = async (tok: string): Promise<string[]> => {
    const res = await call('/_matrix/client/v3/pushrules/', { token: tok });
    return ((res.body.global as Json).room as Json[]).map((r) =>
      r.rule_id as string
    ).sort();
  };
  const join = async (tok: string, roomId: string) => {
    assertEquals(
      (await call(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
        {
          method: 'POST',
          token: tok,
          body: {},
        },
      )).status,
      200,
    );
  };

  // --- /upgrade: rules migrate for ALL local users --------------------------
  const oldRoom = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: aTok,
    body: {
      room_version: '10',
      preset: 'public_chat',
      invite: [alice2.user_id as string],
    },
  })).body.room_id as string;
  await join(a2Tok, oldRoom);
  assertEquals((await roomRule(aTok, oldRoom)).status, 200);
  assertEquals((await roomRule(a2Tok, oldRoom)).status, 200);
  const upgraded = await call(
    `/_matrix/client/v3/rooms/${encodeURIComponent(oldRoom)}/upgrade`,
    { method: 'POST', token: aTok, body: { new_version: '11' } },
  );
  assertEquals(upgraded.status, 200);
  const newRoom = upgraded.body.replacement_room as string;
  await join(a2Tok, newRoom);
  assertEquals(await roomRuleIds(aTok), [newRoom, oldRoom].sort());
  assertEquals(await roomRuleIds(a2Tok), [newRoom, oldRoom].sort());

  // m.push_rules arrives via incremental sync for the user whose rules
  // changed (per-user stream)
  for (
    const [tok, probeId] of [[aTok, '!probe-a:localhost'], [
      a2Tok,
      '!probe-b:localhost',
    ]] as const
  ) {
    const since = (await sync(tok)).body.next_batch as string;
    assertEquals((await roomRule(tok, probeId)).status, 200);
    const res = await sync(tok, `&since=${encodeURIComponent(since)}`);
    const ad = (res.body.account_data as Json).events as Json[];
    assert(
      ad.some((e) => e.type === 'm.push_rules'),
      'm.push_rules in incremental sync',
    );
  }

  // --- manual: create-with-predecessor + tombstone fires the hooks -----------
  // (fresh users so the ruleset assertions stay exact)
  const alice3 = await registerTestUser('pm-d', 'pw-pm-d');
  const alice4 = await registerTestUser('pm-e', 'pw-pm-e');
  const a3Tok = alice3.access_token!;
  const a4Tok = alice4.access_token!;
  const oldRoom2 = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: a3Tok,
    body: {
      room_version: '10',
      preset: 'public_chat',
      invite: [alice4.user_id as string],
    },
  })).body.room_id as string;
  await join(a4Tok, oldRoom2);
  assertEquals((await roomRule(a3Tok, oldRoom2)).status, 200);
  assertEquals((await roomRule(a4Tok, oldRoom2)).status, 200);
  const newRoom2 = (await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: a3Tok,
    body: {
      room_version: '11',
      preset: 'public_chat',
      creation_content: { predecessor: { room_id: oldRoom2 } },
    },
  })).body.room_id as string;
  // the create hook already migrated
  assertEquals(await roomRuleIds(a3Tok), [newRoom2, oldRoom2].sort());
  assertEquals(
    (await call(
      `/_matrix/client/v3/rooms/${
        encodeURIComponent(oldRoom2)
      }/state/m.room.tombstone`,
      {
        method: 'PUT',
        token: a3Tok,
        body: {
          body: 'This room has been replaced',
          replacement_room: newRoom2,
        },
      },
    )).status,
    200,
  );
  assertEquals(await roomRuleIds(a4Tok), [newRoom2, oldRoom2].sort());

  // --- the join hook: a rule set on the old room AFTER the upgrade follows
  //     the user into the new room when they join --------------------------
  assertEquals((await roomRule(cTok, oldRoom2)).status, 200);
  assertEquals(await roomRuleIds(cTok), [oldRoom2]);
  await join(cTok, newRoom2);
  assertEquals(await roomRuleIds(cTok), [newRoom2, oldRoom2].sort());
});
