import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP operation body omission');

suite.test('empty join bodies work through both room IDs and aliases without loosening fields', async () => {
  const owner = await suite.registerTestUser('body-owner', 'pw');
  const member = await suite.registerTestUser('body-member', 'pw');
  const call = async (path: string, token: string, body?: string) => {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/' + path,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + token },
          body,
        },
      ),
    );
    return { status: response.status, body: await response.json() };
  };
  const created = await call(
    'createRoom',
    owner.access_token!,
    JSON.stringify({
      preset: 'public_chat',
      room_alias_name: 'body-room',
    }),
  );
  assertEquals(created.status, 200);
  const roomId = String(created.body.room_id);
  const room = 'rooms/' + encodeURIComponent(roomId);
  for (
    const join of [
      room + '/join',
      'join/' + encodeURIComponent(roomId),
      'join/' + encodeURIComponent('#body-room:localhost'),
    ]
  ) {
    for (const body of [undefined, '']) {
      const joined = await call(join, member.access_token!, body);
      assertEquals(joined.status, 200, join);
      assertEquals(joined.body.room_id, roomId);
      const state = await suite.matrix(
        new Request(
          'http://x/_matrix/client/v3/' + room + '/state/m.room.member/' +
            encodeURIComponent(member.user_id),
          { headers: { Authorization: 'Bearer ' + owner.access_token! } },
        ),
      );
      assertEquals((await state.json()).membership, 'join');
      assertEquals(
        (await call(room + '/leave', member.access_token!)).status,
        200,
      );
    }
  }
  for (const body of [' ', '{', 'null', '[]', '{"reason":null}']) {
    assertEquals(
      (await call(room + '/join', member.access_token!, body)).status,
      400,
      body,
    );
  }
  for (const path of [room + '/ban', room + '/invite', 'login']) {
    assertEquals((await call(path, owner.access_token!)).status, 400, path);
  }
});
