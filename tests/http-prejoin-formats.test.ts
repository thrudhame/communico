import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP prejoin display formats');
type Json = Record<string, unknown>;
suite.test('redacted prejoin names and topics stay pruned in sync and unsigned invite/knock hints', async () => {
  const owner = await suite.registerTestUser('prejoin-redactor', 'pw');
  const guest = await suite.registerTestUser('prejoin-reader', 'pw');
  const call = async (
    path: string,
    token: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method,
        headers: { Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as Json;
  };
  for (const version of ['3', '7', '11', '12']) {
    for (
      const membership of version === '3' ? ['invite'] : ['invite', 'knock']
    ) {
      const made = await call('createRoom', owner.access_token!, {
        room_version: version,
        name: 'private name',
        topic: 'private topic',
        initial_state: membership === 'knock'
          ? [{ type: 'm.room.join_rules', content: { join_rule: 'knock' } }]
          : [],
      });
      const roomId = String(made.room_id),
        room = 'rooms/' + encodeURIComponent(roomId);
      const originals = await Promise.all(
        ['m.room.name', 'm.room.topic'].map((type) =>
          call(room + '/state/' + type + '?format=event', owner.access_token!)
        ),
      );
      if (membership === 'invite') {
        await call(room + '/invite', owner.access_token!, {
          user_id: guest.user_id,
        });
      } else {await call(
          'knock/' + encodeURIComponent(roomId),
          guest.access_token!,
          {},
        );}
      for (const event of originals) {
        await call(
          room + '/redact/' + encodeURIComponent(String(event.event_id)) +
            '/redact-' + String(event.type),
          owner.access_token!,
          {},
          'PUT',
        );
      }
      const sync = await call('sync', guest.access_token!);
      const hints =
        ((((sync.rooms as Json)[membership] as Json)[roomId] as Json)[
          membership + '_state'
        ] as Json).events as Json[];
      const member = await call(
        room + '/state/m.room.member/' + encodeURIComponent(guest.user_id) +
          '?format=event',
        owner.access_token!,
      );
      for (
        const events of [
          hints,
          (member.unsigned as Json)[membership + '_room_state'] as Json[],
        ]
      ) {
        for (const type of ['m.room.name', 'm.room.topic']) {
          assertEquals(
            events.find((e) => e.type === type)?.content,
            {},
            version + ':' + membership + ':' + type,
          );
        }
      }
    }
  }
});
suite.test('held invite and knock sync include create; unsigned hints use the event cut and stripped fields', async () => {
  const owner = await suite.registerTestUser('prejoin-owner', 'pw');
  const guest = await suite.registerTestUser('prejoin-guest', 'pw');
  const call = async (
    path: string,
    token: string,
    body?: unknown,
    method = body === undefined ? 'GET' : 'POST',
  ) => {
    const response = await suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method,
        headers: { Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as Json;
  };
  const check = (events: Json[]) => {
    assert(events.some((e) => e.type === 'm.room.create'));
    for (const event of events) {
      assert(
        !('signatures' in event) && !('event_id' in event) &&
          !('hashes' in event),
      );
      assert(
        !('auth_events' in event) && !('prev_events' in event) &&
          !('room_id' in event),
      );
    }
    assertEquals(
      (events.find((e) => e.type === 'm.room.name')!.content as Json).name,
      'at prejoin',
    );
  };
  for (const version of ['3', '7', '11', '12']) {
    for (
      const membership of version === '3' ? ['invite'] : ['invite', 'knock']
    ) {
      const made = await call('createRoom', owner.access_token!, {
        room_version: version,
        name: 'at prejoin',
        initial_state: membership === 'knock'
          ? [{ type: 'm.room.join_rules', content: { join_rule: 'knock' } }]
          : [],
      });
      const roomId = String(made.room_id),
        room = 'rooms/' + encodeURIComponent(roomId);
      if (membership === 'invite') {
        await call(room + '/invite', owner.access_token!, {
          user_id: guest.user_id,
        });
      } else {await call(
          'knock/' + encodeURIComponent(roomId),
          guest.access_token!,
          {},
        );}
      await call(room + '/state/m.room.name', owner.access_token!, {
        name: 'later publication',
      }, 'PUT');
      const sync = await call('sync', guest.access_token!);
      const section =
        ((sync.rooms as Json)[membership] as Json)[roomId] as Json;
      check((section[membership + '_state'] as Json).events as Json[]);
      const member = await call(
        room + '/state/m.room.member/' + encodeURIComponent(guest.user_id) +
          '?format=event',
        owner.access_token!,
      );
      const hints =
        (member.unsigned as Json)[membership + '_room_state'] as Json[];
      check(hints);
    }
  }
});
