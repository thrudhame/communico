import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP upgrade input');
type Json = Record<string, unknown>;
suite.test('malformed upgrades fail before replacement, alias or tombstone effects', async () => {
  const user = await suite.registerTestUser('upgrade-input', 'pw');
  const call = async (path: string, body?: unknown) => {
    const res = await suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: await res.json() as Json };
  };
  const made = await call('createRoom', { room_alias_name: 'upgrade-input' });
  const roomId = String(made.body.room_id);
  const path = 'rooms/' + encodeURIComponent(roomId);
  const rooms = await theApp().store.rooms();
  for (
    const body of [
      { new_version: '12', additional_creators: [user.user_id, 42] },
      { new_version: '12', additional_creators: null },
      { new_version: '12', additional_creators: {} },
      { new_version: '12', additional_creators: ['not-a-user'] },
      { new_version: 12 },
      { new_version: null },
      [],
      null,
    ]
  ) {
    const result = await call(path + '/upgrade', body);
    assertEquals(result.status, 400, JSON.stringify({ body, result }));
    assertEquals(await theApp().store.rooms(), rooms);
    assertEquals((await call(path + '/state/m.room.tombstone')).status, 404);
  }
  assertEquals(
    (await call(path + '/upgrade', {})).body.errcode,
    'M_MISSING_PARAM',
  );
  assertEquals(
    (await call(path + '/upgrade', { new_version: '99' })).body.errcode,
    'M_UNSUPPORTED_ROOM_VERSION',
  );
  const duplicates = await call(path + '/upgrade', {
    new_version: '12',
    additional_creators: [user.user_id, user.user_id],
  });
  assertEquals(duplicates.status, 200);
  const create = await call(
    'rooms/' + encodeURIComponent(String(duplicates.body.replacement_room)) +
      '/state/m.room.create',
  );
  assertEquals(create.body.additional_creators, [user.user_id, user.user_id]);
});
