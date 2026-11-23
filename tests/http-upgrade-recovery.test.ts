import { assertEquals, assertRejects } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { upgradeRoom } from '#engine/client/upgrade.ts';
import { createRoom } from '#engine/client/write.ts';
import { lookupAlias } from '#engine/server/aliases.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP upgrade recovery');
type Json = Record<string, unknown>;

suite.test('ordinary create predecessors do not uniquely identify an upgrade', async () => {
  const user = await suite.registerTestUser('upgrade-predecessor', 'pw');
  const create = async (body: Json) => {
    const response = await suite.matrix(
      new Request('http://x/_matrix/client/v3/createRoom', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token },
        body: JSON.stringify(body),
      }),
    );
    const result = await response.json() as Json;
    assertEquals(response.status, 200);
    return String(result.room_id);
  };
  const oldRoom = await create({ room_version: '11' });
  const children = [];
  for (let index = 0; index < 2; index++) {
    children.push(
      await create({
        room_version: '12',
        creation_content: { predecessor: { room_id: oldRoom } },
      }),
    );
  }
  assertEquals(new Set(children).size, 2);
  for (const room of children) {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(room) +
          '/state/m.room.create',
        { headers: { Authorization: 'Bearer ' + user.access_token } },
      ),
    );
    assertEquals(response.status, 200);
    assertEquals((await response.json()).predecessor, { room_id: oldRoom });
  }
  const tombstone = await suite.matrix(
    new Request(
      'http://x/_matrix/client/v3/rooms/' + encodeURIComponent(oldRoom) +
        '/state/m.room.tombstone',
      { headers: { Authorization: 'Bearer ' + user.access_token } },
    ),
  );
  assertEquals(tombstone.status, 404);
  await tombstone.body?.cancel();
});

for (const version of ['11', '12']) {
  suite.test(`v${version} concurrent HTTP upgrades share one replacement`, async () => {
    const user = await suite.registerTestUser(
      'upgrade-concurrent-' + version,
      'pw',
    );
    const made = await createRoom({ creator: user.user_id, version: '11' });
    const before = await theApp().store.rooms();
    const request = async () => {
      const response = await suite.matrix(
        new Request(
          'http://x/_matrix/client/v3/rooms/' +
            encodeURIComponent(made.roomId) + '/upgrade',
          {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + user.access_token },
            body: JSON.stringify({ new_version: version }),
          },
        ),
      );
      const result = await response.json();
      assertEquals(response.status, 200);
      return result;
    };
    const [one, two] = await Promise.all([request(), request()]);
    assertEquals(one, two);
    assertEquals((await theApp().store.rooms()).length, before.length + 1);
  });

  suite.test(`v${version} retry reuses the replacement after push-rule failure`, async () => {
    const user = await suite.registerTestUser('upgrade-cut-' + version, 'pw');
    const call = async (path: string, body?: unknown) => {
      const response = await suite.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { Authorization: 'Bearer ' + user.access_token },
          body: body === undefined ? undefined : JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.json() as Json };
    };
    const made = await call('createRoom', { room_version: '11' });
    assertEquals(made.status, 200);
    const oldRoom = String(made.body.room_id);
    const before = await theApp().store.rooms();
    const tenant = theApp().tenant;
    const transaction = tenant.tx.bind(tenant);
    let injected = false;
    tenant.tx = (action) =>
      transaction((tx) => {
        tx.pushRules.roomRulesOf = () => {
          injected = true;
          return Promise.reject(new Error('upgrade-push-rule-cut'));
        };
        return action(tx);
      });
    try {
      await assertRejects(
        () => upgradeRoom(oldRoom, user.user_id, version),
      );
    } finally {
      tenant.tx = transaction;
    }
    assertEquals(injected, true);
    const committed = (await theApp().store.rooms()).filter((id) =>
      !before.includes(id)
    );
    assertEquals(committed.length, 1, 'failure cut follows replacement commit');
    assertEquals(
      (await call(
        'rooms/' + encodeURIComponent(oldRoom) + '/state/m.room.tombstone',
      ))
        .status,
      404,
      'the old room has no durable replacement link at this cut',
    );
    const retry = await call(
      'rooms/' + encodeURIComponent(oldRoom) + '/upgrade',
      {
        new_version: version,
      },
    );
    assertEquals(retry.status, 200);
    assertEquals(retry.body.replacement_room, committed[0]);
    assertEquals((await theApp().store.rooms()).length, before.length + 1);
  });

  suite.test(`v${version} completed upgrade replays the same HTTP result`, async () => {
    const user = await suite.registerTestUser(
      'upgrade-replay-' + version,
      'pw',
    );
    const request = async (path: string, body: Json) => {
      const response = await suite.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + user.access_token },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: await response.json() as Json };
    };
    const made = await request('createRoom', { room_version: '11' });
    assertEquals(made.status, 200);
    const path = 'rooms/' + encodeURIComponent(String(made.body.room_id)) +
      '/upgrade';
    const result = await request(path, { new_version: version });
    assertEquals(result.status, 200);
    const rooms = await theApp().store.rooms();
    const replay = await request(path, { new_version: version });
    assertEquals(replay.status, 200);
    assertEquals(replay.body, result.body);
    assertEquals(await theApp().store.rooms(), rooms);
  });
}

suite.test('facade composition refuses alias handoff before replacement or alias effects', async () => {
  const user = await suite.registerTestUser('upgrade-alias', 'pw');
  const app = theApp();
  const made = await createRoom({
    creator: user.user_id,
    alias: 'upgrade-owned-home',
  });
  const before = await app.store.rooms();
  const alias = '#upgrade-owned-home:' + app.tenant.serverName;
  const descriptor = Object.getOwnPropertyDescriptor(app, 'replica');
  Object.defineProperty(app, 'replica', {
    configurable: true,
    value: { requireScope: () => Promise.resolve() },
  });
  try {
    const error = await assertRejects(() =>
      upgradeRoom(made.roomId, user.user_id, '12')
    );
    assertEquals((error as { status?: number }).status, 503);
    assertEquals(await app.store.rooms(), before);
    assertEquals(await lookupAlias(app.server, alias), made.roomId);
  } finally {
    if (descriptor) Object.defineProperty(app, 'replica', descriptor);
    else Reflect.deleteProperty(app, 'replica');
  }
});
