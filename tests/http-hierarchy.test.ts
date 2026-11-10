import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { lookupPeer } from '#engine/federation/peers.ts';
import { theApp } from '#engine/app.ts';
import { lookupRoom } from '#engine/client/room.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP space hierarchy');
async function call(
  path: string,
  token: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
) {
  const r = await suite.matrix(
    new Request('http://x/_matrix/client/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: r.status, body: await r.json() as Json };
}
async function ok(
  path: string,
  token: string,
  body?: unknown,
  method?: string,
) {
  const r = await call(path, token, body, method);
  assertEquals(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const path = (id: string) =>
  'v1/rooms/' + encodeURIComponent(id) + '/hierarchy';
const base = (id: string) => 'v3/rooms/' + encodeURIComponent(id);
const ids = (r: Json) => (r.rooms as Json[]).map((room) => room.room_id);

suite.test('unheld hierarchy children use signed via discovery and re-filter user access without joining', async () => {
  const a = await suite.registerTestUser('hierarchy-remote', 'pw');
  const root = String(
    (await ok('v3/createRoom', a.access_token!, {
      preset: 'public_chat',
      creation_content: { type: 'm.space' },
    })).room_id,
  );
  let remote = '', publicChild = '', deniedChild = '', filteredChild = '';
  const fake = await startFakeServer({
    ourKeyDoc: async () =>
      await (await suite.matrix(new Request('http://x/_matrix/key/v2/server')))
        .json(),
    handlers: (request) => {
      const prefix = '/_matrix/federation/v1/hierarchy/';
      if (!request.url.pathname.startsWith(prefix)) return null;
      assertEquals(request.verified, true);
      const id = decodeURIComponent(request.url.pathname.slice(prefix.length));
      assertEquals(
        id === deniedChild,
        false,
        'federation inaccessible_children must not be re-requested',
      );
      const summary: Json = {
        room_id: id,
        join_rule: id === filteredChild ? 'invite' : 'public',
        num_joined_members: 1,
        guest_can_join: false,
        world_readable: false,
        children_state: [],
      };
      if (id === remote) {
        summary.room_type = 'm.space';
        summary.children_state = [publicChild, deniedChild, filteredChild].map((
          child,
          i,
        ) => ({
          type: 'm.space.child',
          state_key: child,
          sender: '@remote:' + fake.name,
          origin_server_ts: i,
          content: { via: [fake.name] },
        }));
      }
      return Response.json({
        room: summary,
        children: [],
        inaccessible_children: id === remote ? [deniedChild] : [],
      });
    },
  });
  remote = '!remote:' + fake.name;
  publicChild = '!public:' + fake.name;
  deniedChild = '!denied:' + fake.name;
  filteredChild = '!filtered:' + fake.name;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  try {
    await ok(
      base(root) + '/state/m.space.child/' + encodeURIComponent(remote),
      a.access_token!,
      { via: [fake.name] },
      'PUT',
    );
    assertEquals(ids(await ok(path(root), a.access_token!)), [
      root,
      remote,
      publicChild,
    ]);
    assertEquals(await lookupRoom(remote), null);
    assertEquals(await lookupPeer(theApp().server, fake.name), null);
  } finally {
    setConfigForTests({});
    resetCaCertsForTests();
    await fake.close();
  }
});

suite.test('hierarchy walks stable depth-first pages, binds tokens and rechecks access', async () => {
  const a = await suite.registerTestUser('hierarchy-a', 'pw');
  const b = await suite.registerTestUser('hierarchy-b', 'pw');
  const token = a.access_token!;
  const create = async (space = false, pub = true) =>
    String(
      (await ok('v3/createRoom', token, {
        ...(pub ? { preset: 'public_chat' } : {}),
        ...(space ? { creation_content: { type: 'm.space' } } : {}),
      })).room_id,
    );
  const root = await create(true),
    one = await create(true),
    grand = await create(),
    two = await create();
  const privateRoom = await create(false, false),
    invalid = await create(),
    redacted = await create();
  const link = (parent: string, child: string, content: Json) =>
    ok(
      base(parent) + '/state/m.space.child/' + encodeURIComponent(child),
      token,
      content,
      'PUT',
    );
  await link(root, two, { via: ['localhost'], order: 'b' });
  await link(root, one, { via: ['localhost'], order: 'a', suggested: true });
  await link(one, grand, { via: ['localhost'], suggested: true });
  await link(one, root, { via: ['localhost'] });
  await link(root, privateRoom, { via: ['localhost'], order: 'c' });
  await link(root, invalid, { via: 'localhost' });
  const redactionTarget = await link(root, redacted, { via: ['localhost'] });
  await ok(
    base(root) + '/redact/' +
      encodeURIComponent(String(redactionTarget.event_id)) + '/edge',
    token,
    {},
    'PUT',
  );
  const query = (q = '', user = b.access_token!) => ok(path(root) + q, user);
  assertEquals(ids(await query()), [root, one, grand, two]);
  assertEquals(ids(await query('?max_depth=0')), [root]);
  assertEquals(ids(await query('?max_depth=1')), [root, one, two]);
  assertEquals(ids(await query('?suggested_only=true')), [root, one, grand]);
  const first = await query('?limit=1');
  assertEquals(ids(first), [root]);
  assert(typeof first.next_batch === 'string');
  const from = '?from=' + first.next_batch;
  assertEquals(ids(await query(from + '&limit=1')), [one]);
  assertEquals(ids(await query(from + '&limit=1')), [one]);
  for (const suffix of ['&suggested_only=true', '&max_depth=2']) {
    assertEquals(
      (await call(path(root) + from + suffix, b.access_token!)).status,
      400,
    );
  }
  assertEquals((await call(path(root) + from, token)).status, 400);
  assertEquals((await call(path(one) + from, b.access_token!)).status, 400);
  assertEquals((await call(path(root) + '?from=unknown', token)).status, 400);
  await ok(base(one) + '/state/m.room.join_rules', token, {
    join_rule: 'invite',
  }, 'PUT');
  assertEquals(ids(await query(from)), [two]);
  await ok(base(root) + '/state/m.room.join_rules', token, {
    join_rule: 'invite',
  }, 'PUT');
  assertEquals((await call(path(root) + from, b.access_token!)).status, 403);
  for (
    const q of ['?limit=0', '?limit=no', '?max_depth=-1', '?suggested_only=no']
  ) {
    assertEquals((await call(path(root) + q, token)).status, 400);
  }
});

suite.test('pagination expiry and traversal capacity fail explicitly rather than truncate', async () => {
  const a = await suite.registerTestUser('hierarchy-limits', 'pw');
  const token = a.access_token!;
  const root = String(
    (await ok('v3/createRoom', token, {
      preset: 'public_chat',
      creation_content: { type: 'm.space' },
    })).room_id,
  );
  const child = String(
    (await ok('v3/createRoom', token, { preset: 'public_chat' })).room_id,
  );
  await ok(
    base(root) + '/state/m.space.child/' + encodeURIComponent(child),
    token,
    { via: ['localhost'] },
    'PUT',
  );
  try {
    setConfigForTests({ hierarchy: { sessionseconds: 0 } });
    const first = await ok(path(root) + '?limit=1', token);
    assertEquals(
      (await call(path(root) + '?from=' + first.next_batch, token)).status,
      400,
    );
    setConfigForTests({ hierarchy: { maxrooms: 1 } });
    assertEquals((await call(path(root), token)).status, 503);
  } finally {
    setConfigForTests({});
  }
});

suite.test('federation returns immediate children and distinguishes known inaccessible from unknown', async () => {
  const a = await suite.registerTestUser('hierarchy-fed', 'pw');
  const token = a.access_token!;
  const create = async (content: Json) =>
    String((await ok('v3/createRoom', token, content)).room_id);
  const root = await create({
    preset: 'public_chat',
    creation_content: { type: 'm.space' },
  });
  const child = await create({ preset: 'public_chat' });
  const secret = await create({});
  for (const id of [child, secret, '!unknown:elsewhere']) {
    await ok(
      base(root) + '/state/m.space.child/' + encodeURIComponent(id),
      token,
      { via: ['elsewhere'], suggested: id === child },
      'PUT',
    );
  }
  const fed = fedCaller(suite.matrix, await remoteServer());
  const result = await fed(
    'GET',
    '/_matrix/federation/v1/hierarchy/' + encodeURIComponent(root),
  );
  assertEquals(result.status, 200);
  assertEquals((result.body.room as Json).room_id, root);
  assertEquals((result.body.children as Json[]).map((r) => r.room_id), [child]);
  assertEquals(result.body.inaccessible_children, [secret]);
  const suggested = await fed(
    'GET',
    '/_matrix/federation/v1/hierarchy/' + encodeURIComponent(root) +
      '?suggested_only=true',
  );
  assertEquals(
    (suggested.body.room as Json).children_state instanceof Array,
    true,
  );
  assertEquals(suggested.body.inaccessible_children, []);
  assertEquals(
    (await fed(
      'GET',
      '/_matrix/federation/v1/hierarchy/' + encodeURIComponent(secret),
    )).status,
    404,
  );
});
