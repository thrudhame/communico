// Remaining doltgres sync consumer assertions, using the landed room routes.
import { assert, assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { inviteFor, inviteIntentProvider } from '#engine/federation/invites.ts';
import { inviteDeps } from '#engine/federation/context.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { seedServer } from '#tests/federation/doc-helper.ts';
import { fedCaller } from '#tests/http-federation.ts';
import { remoteEvent, wireOf } from '#tests/fixtures/remote.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP sync consumers');
async function call(
  path: string,
  token: string,
  method = 'GET',
  body?: unknown,
) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
const sync = async (token: string, since?: unknown) => {
  const res = await call(
    '/_matrix/client/v3/sync?timeout=0' +
      (since === undefined ? '' : '&since=' + since),
    token,
  );
  assertEquals(res.status, 200);
  return res.body;
};
const section = (body: Json, kind: string) =>
  (body.rooms as Json)[kind] as Json;

suite.test('sync tokens bound messages in both directions and preserve room cursor round trips', async () => {
  const alice = await suite.registerTestUser('sy-token', 'pw');
  const token = alice.access_token!;
  const created = await call(
    '/_matrix/client/v3/createRoom',
    token,
    'POST',
    {},
  );
  assertEquals(created.status, 200);
  const roomId = String(created.body.room_id);
  const base = '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId);
  const send = async (n: number) => {
    assertEquals(
      (await call(base + '/send/m.room.message/t' + n, token, 'PUT', {
        msgtype: 'm.text',
        body: 'm' + n,
      })).status,
      200,
    );
  };
  await send(1);
  await send(2);
  const first = (await sync(token)).next_batch;
  assert(/^s\d+_p\d+_t\d+_r\d+_a\d+_d\d+_m\d+_k\d+_n\d+$/.test(String(first)));
  await send(3);
  await send(4);
  const second = (await sync(token)).next_batch;
  await send(5);
  const bodies = (body: Json) =>
    (body.chunk as Json[]).map((e) => (e.content as Json).body);
  const forward = await call(base + '/messages?dir=f&from=' + first, token);
  assertEquals(forward.status, 200);
  assertEquals(bodies(forward.body), ['m3', 'm4', 'm5']);
  const bounded = await call(
    base + '/messages?dir=f&from=' + first + '&to=' + second,
    token,
  );
  assertEquals(bounded.status, 200);
  assertEquals(bodies(bounded.body), ['m3', 'm4']);
  const back = await call(
    base + '/messages?dir=b&limit=4&from=' + second,
    token,
  );
  assertEquals(back.status, 200);
  assertEquals(bodies(back.body), ['m4', 'm3', 'm2', 'm1']);
  const garbage = await call(base + '/messages?dir=f&from=not-a-token', token);
  assertEquals(garbage.status, 400);
  assertEquals(garbage.body.errcode, 'M_INVALID_PARAM');
  const page = await call(base + '/messages?dir=b&limit=2', token);
  assertEquals(page.status, 200);
  assert(/^c\d+_\d+$/.test(String(page.body.end)));
  const next = await call(
    base + '/messages?dir=b&limit=2&from=' + page.body.end,
    token,
  );
  assertEquals(next.status, 200);
  assertEquals(bodies(next.body), ['m3', 'm2']);
});

suite.test('ignored local inviters are omitted just like ignored remote inviters', async () => {
  const alice = await suite.registerTestUser('sy-ignore-a', 'pw');
  const bob = await suite.registerTestUser('sy-ignore-b', 'pw');
  const created = await call(
    '/_matrix/client/v3/createRoom',
    alice.access_token!,
    'POST',
    { invite: [bob.user_id] },
  );
  assertEquals(created.status, 200);
  const roomId = String(created.body.room_id);
  assert(section(await sync(bob.access_token!), 'invite')[roomId]);
  const ignored = await call(
    '/_matrix/client/v3/user/' + encodeURIComponent(bob.user_id) +
      '/account_data/m.ignored_user_list',
    bob.access_token!,
    'PUT',
    { ignored_users: { [alice.user_id]: {} } },
  );
  assertEquals(ignored.status, 200);
  assertEquals(
    section(await sync(bob.access_token!), 'invite')[roomId],
    undefined,
  );
});

suite.test('HTTP v2 OOB invite exposes is_direct; delivered rejection renders signed leave since before rejection', async () => {
  const app = theApp();
  const user = await suite.registerTestUser('sy-delivered', 'pw');
  const previousCa = config().federation.cacerts;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  let sent: Json | null = null;
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: app.tenant.serverName,
        verify_keys: { [app.tenant.keyId]: { key: app.tenant.publicB64 } },
      }),
    handlers: (req) => {
      if (req.path.startsWith('/_matrix/federation/v1/make_leave/')) {
        return Response.json({
          event: { prev_events: [], auth_events: [], depth: 2 },
        });
      }
      if (req.path.startsWith('/_matrix/federation/v2/send_leave/')) {
        assert(req.verified);
        sent = req.json() as Json;
        return Response.json({});
      }
      return null;
    },
  });
  try {
    const roomId = '!delivered:' + fake.name;
    const event = await remoteEvent(roomId, fake, '11', {
      type: 'm.room.member',
      state_key: user.user_id,
      sender: '@zoe:' + fake.name,
      content: { membership: 'invite', is_direct: true },
      prev_events: [],
      auth_events: [],
    });
    await seedServer(app.server, fake);
    const fed = fedCaller(suite.matrix, fake);
    assert(!(await app.store.rooms()).includes(roomId));
    const accepted = await fed(
      'PUT',
      '/_matrix/federation/v2/invite/' + encodeURIComponent(roomId) + '/' +
        encodeURIComponent(event.event_id!),
      { room_version: '11', event: wireOf(event), invite_room_state: [] },
    );
    assertEquals(accepted.status, 200);
    assert(
      !(await app.store.rooms()).includes(roomId),
      'OOB invite must not create a resident room file',
    );
    const invited = await sync(user.access_token!);
    const entry = section(invited, 'invite')[roomId] as Json | undefined;
    assert(
      entry !== undefined,
      'valid HTTP v2 invite reaches rooms.invite without a room file',
    );
    assert(
      ((entry.invite_state as Json).events as Json[]).some((e) =>
        e.type === 'm.room.member' && (e.content as Json).is_direct === true
      ),
    );
    const rejectingSince = invited.next_batch;
    const rejected = await call(
      '/_matrix/client/v3/rooms/' + encodeURIComponent(roomId) + '/leave',
      user.access_token!,
      'POST',
      {},
    );
    assertEquals(rejected.status, 200);
    const deps = inviteDeps();
    assertEquals(
      (await inviteFor(roomId, user.user_id, deps))?.status,
      'rejecting',
    );
    const job = await inviteIntentProvider(deps)(app.server, fake.name);
    assert(job !== null);
    await job.run();
    const stored = await inviteFor(roomId, user.user_id, deps);
    assertEquals(stored?.status, 'rejected');
    const signed = JSON.parse(stored!.eventJson) as Json;
    assert((signed.signatures as Json)[app.tenant.serverName]);
    assert(sent !== null);
    const delivered = await sync(user.access_token!, rejectingSince);
    assert(delivered.next_batch !== rejectingSince);
    const left = section(delivered, 'leave')[roomId] as Json;
    assertEquals((left.timeline as Json).events, []);
    const members = ((left.state as Json).events as Json[]).filter((e) =>
      e.type === 'm.room.member'
    );
    assertEquals(members, [{
      event_id: signed.event_id,
      origin_server_ts: signed.origin_server_ts,
      type: signed.type,
      state_key: signed.state_key,
      content: signed.content,
      sender: signed.sender,
    }]);
    assertEquals((members[0].content as Json).membership, 'leave');
    assertEquals(
      section(
        await sync(user.access_token!, delivered.next_batch),
        'leave',
      )[roomId],
      undefined,
    );
  } finally {
    await fake.close();
    setConfigForTests({ federation: { cacerts: previousCa } });
    resetCaCertsForTests();
  }
});
