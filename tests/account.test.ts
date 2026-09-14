// tests/account.test.ts — §2 rows A1–A7 at the wire (plan §3.8): the real
// endpoint trees in process via pathfinder() (the http-contract.test.ts
// pattern) against live doltgres. A8 is deliberately ABSENT: pathfinder
// 0.2.x exposes no body.bytes(), so the fatal-UTF-8 decode check cannot
// exist without request._raw — A8 stays red per plan §3.7 (pathfinder
// TODO-0.3.0 item 1).
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const SN = serverName();

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
  const res = await matrix(new Request(`http://x${path}`, {
    method: init.method ?? 'GET',
    headers,
    body,
  }));
  const text = await res.text();
  let parsed: Json = {};
  if (text !== '') {
    try {
      parsed = JSON.parse(text) as Json;
    } catch {
      parsed = { _raw: text };
    }
  }
  return { status: res.status, body: parsed };
}

function loginBody(localpart: string, password: string, extra: Json = {}): Json {
  return {
    identifier: { type: 'm.id.user', user: `@${localpart}:${SN}` },
    type: 'm.login.password',
    password,
    ...extra,
  };
}

function pwAuth(localpart: string, password: string, session?: string): Json {
  const auth: Json = {
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: `@${localpart}:${SN}` },
    password,
  };
  if (session !== undefined) auth.session = session;
  return auth;
}

Deno.test('A1: login honors device_id + display name; GET/list/PUT; unknown → 404', async () => {
  const alice = await registerTestUser('a1alice', 'pw-a1alice');
  const login = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a1alice', 'pw-a1alice', {
      device_id: 'login_device',
      initial_device_display_name: 'device display',
    }),
  });
  assertEquals(login.status, 200);
  assertEquals(login.body.device_id, 'login_device');
  const tok = alice.access_token;
  const one = await call('/_matrix/client/v3/devices/login_device', { token: tok });
  assertEquals(one.status, 200);
  assertEquals(one.body, { device_id: 'login_device', display_name: 'device display' });
  assertEquals(
    (await call('/_matrix/client/v3/devices/unknown_device', { token: tok })).status,
    404,
  );
  const list = await call('/_matrix/client/v3/devices', { token: tok });
  assertEquals(list.status, 200);
  const ids = (list.body.devices as Json[]).map((d) => d.device_id);
  assert(ids.includes('login_device'), `devices[] lacks login_device: ${ids}`);
  assert(ids.includes(alice.device_id), `devices[] lacks the register device: ${ids}`);
  const put = await call('/_matrix/client/v3/devices/login_device', {
    method: 'PUT',
    token: tok,
    body: { display_name: 'new device display' },
  });
  assertEquals(put.status, 200);
  const after = await call('/_matrix/client/v3/devices/login_device', { token: tok });
  assertEquals(after.body.display_name, 'new device display');
  assertEquals((await call('/_matrix/client/v3/devices/unknown_device', {
    method: 'PUT',
    token: tok,
    body: { display_name: 'x' },
  })).status, 404);
});

Deno.test('A1: DELETE device — bodyless 401 (session/flows/params), wrong pw 401 M_FORBIDDEN, right pw 200, token dead', async () => {
  const alice = await registerTestUser('a1del', 'pw-a1del');
  const tok = alice.access_token;
  const l2 = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a1del', 'pw-a1del', { device_id: 'd2' }),
  });
  assertEquals(l2.status, 200);
  const d2tok = l2.body.access_token as string;
  // No body at all → the UIA 401 with session, flows, params.
  const r1 = await call('/_matrix/client/v3/devices/d2', { method: 'DELETE', token: tok });
  assertEquals(r1.status, 401);
  assertEquals(typeof r1.body.session, 'string');
  assert(Array.isArray(r1.body.flows));
  assert('params' in r1.body);
  // Wrong password, no session → 401 M_FORBIDDEN carrying the UIA keys.
  const r2 = await call('/_matrix/client/v3/devices/d2', {
    method: 'DELETE',
    token: tok,
    body: { auth: pwAuth('a1del', 'WRONG') },
  });
  assertEquals(r2.status, 401);
  assertEquals(r2.body.errcode, 'M_FORBIDDEN');
  assertEquals(typeof r2.body.error, 'string');
  assert(Array.isArray(r2.body.flows));
  assert('params' in r2.body);
  assertEquals(typeof r2.body.session, 'string');
  // Right password with the session → 200; device gone; d2's token dead.
  const r3 = await call('/_matrix/client/v3/devices/d2', {
    method: 'DELETE',
    token: tok,
    body: { auth: pwAuth('a1del', 'pw-a1del', r2.body.session as string) },
  });
  assertEquals(r3.status, 200);
  assertEquals((await call('/_matrix/client/v3/devices/d2', { token: tok })).status, 404);
  assertEquals((await call('/_matrix/client/v3/sync', { token: d2tok })).status, 401);
});

Deno.test("A1: DELETE with another user's creds → 403 (device survives); own creds → 200 → 404", async () => {
  const alice = await registerTestUser('a1xalice', 'pw-xa');
  await registerTestUser('a1xbob', 'pw-xb');
  const l = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a1xalice', 'pw-xa', { device_id: 'd3' }),
  });
  assertEquals(l.status, 200);
  // Bob's VALID creds in auth, alice's token → 403 before any password
  // verification (identifier ≠ caller).
  const r = await call('/_matrix/client/v3/devices/d3', {
    method: 'DELETE',
    token: alice.access_token,
    body: { auth: pwAuth('a1xbob', 'pw-xb') },
  });
  assertEquals(r.status, 403);
  assertEquals(r.body.errcode, 'M_FORBIDDEN');
  assertEquals((await call('/_matrix/client/v3/devices/d3', { token: alice.access_token })).status, 200);
  const ok = await call('/_matrix/client/v3/devices/d3', {
    method: 'DELETE',
    token: alice.access_token,
    body: { auth: pwAuth('a1xalice', 'pw-xa') },
  });
  assertEquals(ok.status, 200);
  assertEquals((await call('/_matrix/client/v3/devices/d3', { token: alice.access_token })).status, 404);
});

Deno.test('A2+A3: profile displayname/avatar_url — authed self-write, UNauthed read, foreign mxc verbatim, other-user write → 403', async () => {
  const u = await registerTestUser('a2user', 'pw-a2user');
  const other = await registerTestUser('a2other', 'pw-a2other');
  const mx = u.user_id;
  const put = await call(`/_matrix/client/v3/profile/${mx}/displayname`, {
    method: 'PUT',
    token: u.access_token,
    body: { displayname: 'my_display_name' },
  });
  assertEquals(put.status, 200);
  const get = await call(`/_matrix/client/v3/profile/${mx}/displayname`); // unauthenticated
  assertEquals(get.status, 200);
  assertEquals(get.body, { displayname: 'my_display_name' });
  const putA = await call(`/_matrix/client/v3/profile/${mx}/avatar_url`, {
    method: 'PUT',
    token: u.access_token,
    body: { avatar_url: 'mxc://example.com/SEsfnsuifSDFSSEF' },
  });
  assertEquals(putA.status, 200); // foreign mxc accepted verbatim
  const getA = await call(`/_matrix/client/v3/profile/${mx}/avatar_url`);
  assertEquals(getA.body, { avatar_url: 'mxc://example.com/SEsfnsuifSDFSSEF' });
  const forbidden = await call(`/_matrix/client/v3/profile/${mx}/displayname`, {
    method: 'PUT',
    token: other.access_token,
    body: { displayname: 'nope' },
  });
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.body.errcode, 'M_FORBIDDEN');
});

Deno.test('A4: change password — one-shot UIA, old pw dies, caller token kept, logout_devices default/false', async () => {
  const u = await registerTestUser('a4user', 'pw-a4-old');
  const second = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-old'),
  });
  assertEquals(second.status, 200);
  const secondTok = second.body.access_token as string;
  // One-shot change — no prior session (Complement's changePassword).
  const ch = await call('/_matrix/client/v3/account/password', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a4user', 'pw-a4-old'), new_password: 'pw-a4-new' },
  });
  assertEquals(ch.status, 200);
  const oldLogin = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-old'),
  });
  assertEquals(oldLogin.status, 403);
  assertEquals(oldLogin.body.errcode, 'M_FORBIDDEN');
  const newLogin = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-new'),
  });
  assertEquals(newLogin.status, 200);
  assertEquals(newLogin.body.user_id, u.user_id);
  // The caller's own token survives the change…
  const who = await call('/_matrix/client/v3/account/whoami', { token: u.access_token });
  assertEquals(who.status, 200);
  assertEquals(who.body.user_id, u.user_id);
  // …the other pre-change token does not (default logout_devices).
  assertEquals((await call('/_matrix/client/v3/account/whoami', { token: secondTok })).status, 401);
  // logout_devices:false → other tokens survive.
  const third = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a4user', 'pw-a4-new'),
  });
  const thirdTok = third.body.access_token as string;
  const ch2 = await call('/_matrix/client/v3/account/password', {
    method: 'POST',
    token: u.access_token,
    body: {
      auth: pwAuth('a4user', 'pw-a4-new'),
      new_password: 'pw-a4-new2',
      logout_devices: false,
    },
  });
  assertEquals(ch2.status, 200);
  assertEquals((await call('/_matrix/client/v3/account/whoami', { token: thirdTok })).status, 200);
});

Deno.test("A5: pushers — set never fetches data.url; logged-out tokens' pushers die, the caller's survives", async () => {
  const u = await registerTestUser('a5user', 'pw-a5');
  const second = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a5user', 'pw-a5'),
  });
  assertEquals(second.status, 200);
  const pusher = {
    data: { url: 'https://dummy.url/_matrix/push/v1/notify' },
    profile_tag: 'tag',
    kind: 'http',
    app_id: 'complement',
    app_display_name: 'complement display name',
    device_display_name: 'device display name',
    pushkey: 'a_push_key',
    lang: 'en',
  };
  // Second session sets a pusher — the dummy URL is never contacted (a
  // fetch would hang/fail the request instead of returning 200).
  const set1 = await call('/_matrix/client/v3/pushers/set', {
    method: 'POST',
    token: second.body.access_token as string,
    body: pusher,
  });
  assertEquals(set1.status, 200);
  const ch = await call('/_matrix/client/v3/account/password', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a5user', 'pw-a5'), new_password: 'pw-a5b' },
  });
  assertEquals(ch.status, 200);
  const list0 = await call('/_matrix/client/v3/pushers', { token: u.access_token });
  assertEquals((list0.body.pushers as unknown[]).length, 0);
  // The caller's own pusher rides the kept token through a change.
  const set2 = await call('/_matrix/client/v3/pushers/set', {
    method: 'POST',
    token: u.access_token,
    body: pusher,
  });
  assertEquals(set2.status, 200);
  const ch2 = await call('/_matrix/client/v3/account/password', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a5user', 'pw-a5b'), new_password: 'pw-a5c' },
  });
  assertEquals(ch2.status, 200);
  const list1 = await call('/_matrix/client/v3/pushers', { token: u.access_token });
  const pushers = list1.body.pushers as Json[];
  assertEquals(pushers.length, 1);
  assertEquals(pushers[0].app_id, 'complement');
  assertEquals(pushers[0].pushkey, 'a_push_key');
  assertEquals(pushers[0].kind, 'http');
  assertEquals(pushers[0].app_display_name, 'complement display name');
  assertEquals(pushers[0].device_display_name, 'device display name');
  assertEquals(pushers[0].profile_tag, 'tag');
  assertEquals(pushers[0].lang, 'en');
  assertEquals(pushers[0].data, { url: 'https://dummy.url/_matrix/push/v1/notify' });
});

Deno.test('A6: deactivate — flows include m.login.password; wrong pw 401 M_FORBIDDEN; right pw 200; later login 403', async () => {
  const u = await registerTestUser('a6user', 'pw-a6');
  const d1 = await call('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    token: u.access_token,
    body: {},
  });
  assertEquals(d1.status, 401);
  assert(
    (d1.body.flows as { stages: string[] }[]).some((f) => f.stages.includes('m.login.password')),
    `flows lack m.login.password: ${JSON.stringify(d1.body.flows)}`,
  );
  const d2 = await call('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a6user', 'WRONG') },
  });
  assertEquals(d2.status, 401);
  assertEquals(d2.body.errcode, 'M_FORBIDDEN');
  const d3 = await call('/_matrix/client/v3/account/deactivate', {
    method: 'POST',
    token: u.access_token,
    body: { auth: pwAuth('a6user', 'pw-a6') },
  });
  assertEquals(d3.status, 200);
  assertEquals(d3.body.id_server_unbind_result, 'success');
  const login = await call('/_matrix/client/v3/login', {
    method: 'POST',
    body: loginBody('a6user', 'pw-a6'),
  });
  assertEquals(login.status, 403);
  assertEquals(login.body.errcode, 'M_USER_DEACTIVATED');
});

Deno.test('A7: account data — bare content, overwrite, per-room, missing → 404, other user → 403', async () => {
  const u = await registerTestUser('a7user', 'pw-a7');
  const other = await registerTestUser('a7other', 'pw-a7o');
  const base = `/_matrix/client/v3/user/${u.user_id}/account_data/test.key`;
  assertEquals((await call(base, { token: u.access_token })).status, 404);
  assertEquals((await call(base, {
    method: 'PUT',
    token: u.access_token,
    body: { value: 'first' },
  })).status, 200);
  const g1 = await call(base, { token: u.access_token });
  assertEquals(g1.status, 200);
  assertEquals(g1.body, { value: 'first' }); // the BARE content object
  await call(base, { method: 'PUT', token: u.access_token, body: { value: 'second' } });
  assertEquals((await call(base, { token: u.access_token })).body, { value: 'second' });
  // Per-room, same semantics (roomId opaque — no membership check in M2).
  const room = await call('/_matrix/client/v3/createRoom', {
    method: 'POST',
    token: u.access_token,
    body: {},
  });
  assertEquals(room.status, 200);
  const roomId = room.body.room_id as string;
  assert(typeof roomId === 'string' && roomId.length > 0, `no room_id: ${JSON.stringify(room.body)}`);
  const rbase = `/_matrix/client/v3/user/${u.user_id}/rooms/${roomId}/account_data/test.key`;
  assertEquals((await call(rbase, {
    method: 'PUT',
    token: u.access_token,
    body: { value: 'room-first' },
  })).status, 200);
  assertEquals((await call(rbase, { token: u.access_token })).body, { value: 'room-first' });
  // Another user's account data → 403.
  const forbidden = await call(
    `/_matrix/client/v3/user/${other.user_id}/account_data/test.key`,
    { token: u.access_token },
  );
  assertEquals(forbidden.status, 403);
  assertEquals(forbidden.body.errcode, 'M_FORBIDDEN');
});
