import { assert, assertEquals } from '@std/assert';
import { serverName, setConfigForTests } from '#engine/config.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { projectThrough } from '#engine/server/project.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { startHttp } from './http-app.ts';
import { fedCaller, remoteServer, signTemplate } from './http-federation.ts';

type Json = Record<string, unknown>;

Deno.test('partial send_join responses share the frozen full membership operation', async (t) => {
  for (const title of ['named', 'alias', 'heroes'] as const) {
    await t.step(title, async () => {
      const http = await startHttp();
      setConfigForTests({
        encryption: {
          allowunencryptedcreation: true,
          allowunencryptedjoining: true,
        },
      });
      try {
        const self = serverName();
        const creator = '@alice:' + self;
        const signer = http.app.tenant.signer();
        const made = await createRoom(http.app.store, {
          creator,
          preset: 'public_chat',
          version: '11',
          initial_state: title === 'named'
            ? [{
              type: 'm.room.name',
              state_key: '',
              content: { name: 'Frozen join room' },
            }]
            : title === 'alias'
            ? [{
              type: 'm.room.canonical_alias',
              state_key: '',
              content: { alias: '#frozen:' + self },
            }]
            : [],
        }, signer);
        const room = await openRoom(http.app.store, made.roomId);
        // More members than the five summary heroes; every local send uses its
        // actual completion target before the HTTP consumer observes the room.
        for (let i = 0; i < 6; i++) {
          const user = '@member' + i + ':' + self;
          const result = await sendLocal(room, {
            type: 'm.room.member',
            state_key: user,
            sender: user,
            content: { membership: 'join' },
            origin_server_ts: Date.now(),
          }, signer);
          assertEquals(result.standing, 'accepted');
          assert(result.completion);
          await projectThrough(http.app.store, result.completion);
        }
        const peer = await remoteServer('partial-' + title + '.test');
        const user = '@joining:' + peer.name;
        if (title === 'named') {
          const invite = await sendLocal(room, {
            type: 'm.room.member',
            state_key: user,
            sender: creator,
            content: { membership: 'invite' },
            origin_server_ts: Date.now(),
          }, signer);
          assertEquals(invite.standing, 'accepted');
          assert(invite.completion);
          await projectThrough(http.app.store, invite.completion);
        }
        const fed = fedCaller(http.matrix, peer);
        const path = encodeURIComponent(made.roomId) + '/' +
          encodeURIComponent(user);
        const template = await fed(
          'GET',
          '/_matrix/federation/v1/make_join/' + path + '?ver=11',
        );
        assertEquals(template.status, 200);
        const join = await signTemplate(template.body.event as Json, peer);
        const suffix = encodeURIComponent(made.roomId) + '/' +
          encodeURIComponent(String(join.event_id));
        const send = (partial: boolean, v = 'v2') =>
          fed(
            'PUT',
            '/_matrix/federation/' + v + '/send_join/' + suffix +
              (partial ? '?omit_members=true' : ''),
            toWire(join, '11'),
          );
        // Exercise both response orders. The optional response is not another
        // membership operation, regardless of which representation came first.
        const first = await send(title !== 'alias');
        assertEquals(first.status, 200);
        const full = title === 'alias' ? first : await send(false);
        const partial = title === 'alias' ? await send(true) : first;
        assertEquals(partial.status, 200);
        assertEquals(partial.body.members_omitted, true);
        assertEquals(full.body.members_omitted, false);
        assertEquals(
          partial.body.servers_in_room,
          [self],
          'joining host is not in the pre-join cut',
        );
        assertEquals(partial.body.event, full.body.event);
        const state = partial.body.state as Json[];
        const allState = full.body.state as Json[];
        const members = state.filter((e) => e.type === 'm.room.member');
        assertEquals(
          members.length,
          title === 'heroes' ? 5 : title === 'named' ? 1 : 0,
        );
        if (title === 'named') {
          assertEquals(members[0].state_key, user);
          assertEquals((members[0].content as Json).membership, 'invite');
        }
        assertEquals(
          allState.filter((e) => e.type === 'm.room.member').length,
          title === 'named' ? 8 : 7,
        );
        assertEquals(
          state.filter((e) => e.type !== 'm.room.member'),
          allState.filter((e) => e.type !== 'm.room.member'),
        );
        const encodedState = new Set(state.map((e) => JSON.stringify(e)));
        assert(
          (partial.body.auth_chain as Json[]).every((e) =>
            !encodedState.has(JSON.stringify(e))
          ),
          'partial auth omits state duplicates',
        );
        const topic = await sendLocal(room, {
          type: 'm.room.topic',
          state_key: '',
          sender: creator,
          content: { topic: 'after saved join' },
          origin_server_ts: Date.now(),
        }, signer);
        assert(topic.completion);
        await projectThrough(http.app.store, topic.completion);
        assertEquals(
          (await send(true)).body,
          partial.body,
          'partial replay stays on the original cut',
        );
        assertEquals(
          (await send(false)).body,
          full.body,
          'full replay stays on the same cut',
        );
        const legacy = await send(false, 'v1');
        assertEquals(legacy.status, 200);
        const {
          members_omitted: _omitted,
          servers_in_room: _servers,
          ...legacyBody
        } = full.body;
        assertEquals<unknown>(legacy.body, [200, legacyBody]);
      } finally {
        setConfigForTests({});
        await http.close();
      }
    });
  }
});
