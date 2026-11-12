import { assert, assertEquals, assertThrows } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import {
  ban,
  invite,
  join,
  kick,
  knock,
  leave,
  unban,
} from '#engine/room/membership.ts';
import { httpSuite } from '#tests/http-app.ts';
import { joinRemote } from '#engine/room/join.ts';
import { receiveInvite } from '#engine/federation/invites.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  wireOf,
} from '#tests/fixtures/remote.ts';
import { makeFakeRoom } from '#tests/fixtures/remote-room.ts';
import { testRemoteServer } from '#tests/fixtures/signer.ts';
import { StateDelivery } from '#engine/client/state-delivery.ts';
import { admitState } from '#engine/client/state-admission.ts';
import { eventStreamMax } from '#engine/server/stream.ts';
import { reopen } from '#engine/room/membership.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('client state-delivery transition matrix');
const paths = [
  'legacy',
  'stable',
  'unstable',
  'list',
  'subscription',
  'reentry',
] as const;
type Path = typeof paths[number];
const events = (v: unknown) => (v ?? []) as Json[];
const obj = (v: unknown) => (v ?? {}) as Json;
const selected = [['m.room.encryption', ''], ['org.example.delivery', 'key'], [
  'm.room.member',
  '$ME',
]];

async function call(token: string, route: string, body?: Json) {
  const response = await suite.matrix(
    new Request('http://x' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as Json;
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(name: string) {
  const app = theApp();
  const alice = await suite.registerTestUser(name + '-a', 'pw');
  const bob = await suite.registerTestUser(name + '-b', 'pw');
  const signer = app.tenant.signer();
  const { roomId } = await createRoom(app.store, {
    creator: alice.user_id,
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(app.store, roomId);
  const send = async (
    type: string,
    content: Json,
    key = '',
    sender = alice.user_id,
  ) => {
    const result = await sendLocal(room, {
      type,
      state_key: key,
      sender,
      content,
    }, signer);
    assertEquals(result.standing, 'accepted', result.reason ?? undefined);
    return result.eventId;
  };
  const encryption = await send('m.room.encryption', {
    algorithm: 'm.megolm.v1.aes-sha2',
  });
  const custom = await send('org.example.delivery', {
    value: 'older than since',
  }, 'key');
  return {
    app,
    alice,
    bob,
    signer,
    room,
    roomId,
    send,
    encryption,
    custom,
    ...protocols(name, bob.access_token!, roomId),
  };
}

function protocols(name: string, token: string, roomId: string) {
  const positions = new Map<Path, string>();
  const sync = async (path: Path, baseline = false, outside = false, options: {
    limit?: number;
    lazy?: boolean;
    full?: boolean;
    state?: Json;
    filterId?: string;
  } = {}) => {
    const pos = baseline ? undefined : positions.get(path);
    if (['legacy', 'stable', 'unstable'].includes(path)) {
      const query = new URLSearchParams({ timeout: '0' });
      if (pos) query.set('since', pos);
      if (path !== 'legacy') {
        query.set(
          path === 'stable'
            ? 'use_state_after'
            : 'org.matrix.msc4222.use_state_after',
          'true',
        );
      }
      if (options.full !== undefined) {
        query.set('full_state', String(options.full));
      }
      query.set(
        'filter',
        options.filterId ?? JSON.stringify({
          room: {
            timeline: {
              limit: options.limit ?? 0,
              types: ['m.room.encrypted'],
            },
            state: {
              lazy_load_members: options.lazy ?? true,
              ...options.state,
            },
          },
        }),
      );
      const body = await call(token, '/_matrix/client/v3/sync?' + query);
      if (baseline) positions.set(path, String(body.next_batch));
      const rooms = obj(body.rooms);
      return obj(obj(rooms.join)[roomId] ?? obj(rooms.leave)[roomId]);
    }
    const config = {
      required_state: selected,
      timeline_limit: options.limit ?? 0,
    };
    const body = await call(
      token,
      '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync?timeout=0' +
        (pos ? '&pos=' + encodeURIComponent(pos) : ''),
      {
        conn_id: name + '-' + path,
        ...(path === 'subscription'
          ? { room_subscriptions: outside ? {} : { [roomId]: config } }
          : {
            lists: {
              main: {
                ...config,
                ranges: outside ? [[1000, 1000]] : [[0, 999]],
              },
            },
          }),
      },
    );
    if (baseline || outside) positions.set(path, String(body.pos));
    return obj(obj(body.rooms)[roomId]);
  };
  const baseline = async () => {
    for (const path of paths) await sync(path, true);
    await sync('reentry', false, true);
  };
  return { sync, baseline };
}

suite.test('ordinary reset modifiers preserve filtering, lazy selection and explicit full-state expansion', async () => {
  const f = await fixture('delivery-modifiers');
  await invite(f.room, f.alice.user_id, f.bob.user_id, f.signer);
  await f.baseline();
  await join(f.room, f.bob.user_id, f.signer);
  const stored = await call(
    f.bob.access_token!,
    '/_matrix/client/v3/user/' + encodeURIComponent(f.bob.user_id) + '/filter',
    {
      room: {
        timeline: { limit: 0, not_types: ['*'] },
        state: {
          types: ['*'],
          not_types: ['m.room.encryption'],
          lazy_load_members: true,
        },
      },
    },
  );
  for (const path of ['legacy', 'stable', 'unstable'] as const) {
    const stateOf = (entry: Json) =>
      events(
        obj(
          entry[
            path === 'legacy'
              ? 'state'
              : path === 'stable'
              ? 'state_after'
              : 'org.matrix.msc4222.state_after'
          ],
        ).events,
      );
    for (const limit of [0, 1, 100]) {
      for (const lazy of [false, true]) {
        const state = stateOf(
          await f.sync(path, false, false, { limit, lazy, full: false }),
        );
        assert(state.some((e) => e.event_id === f.encryption));
        assert(state.some((e) => e.event_id === f.custom));
        assert(state.some((e) => e.state_key === f.bob.user_id));
      }
    }
    for (
      const stateFilter of [
        { types: ['*'], not_types: ['m.room.encryption'] },
        { senders: [f.alice.user_id], not_senders: [f.alice.user_id] },
      ]
    ) {
      const state = stateOf(
        await f.sync(path, false, false, { state: stateFilter }),
      );
      assert(
        !state.some((e) => e.event_id === f.encryption),
        'reset bypassed deny filter',
      );
    }
    const filtered = stateOf(
      await f.sync(path, false, false, { filterId: String(stored.filter_id) }),
    );
    assert(!filtered.some((e) => e.event_id === f.encryption));
    assert(filtered.some((e) => e.event_id === f.custom));
    const full = stateOf(await f.sync(path, false, false, { full: true }));
    assert(full.some((e) => e.event_id === f.encryption));
  }
});

suite.test('coverage advances only for rendered full events; scope and lazy selection share the owner', async () => {
  const f = await fixture('delivery-coverage');
  await join(f.room, f.bob.user_id, f.signer);
  const end = await eventStreamMax(f.app.server);
  const admission = await admitState(f.room, {
    userId: f.bob.user_id,
    ceiling: end,
  });
  const owner = await StateDelivery.capture(f.room, f.bob.user_id, {
    protocol: 'sliding',
  }, end);
  const prepared = owner.required(admission, {
    required: [['*', '*']],
    timeline: [],
    limited: false,
  });
  assertEquals(prepared.rendered([]), { required: [], members: {} });
  const rendered = prepared.rows.map((row) => ({ event_id: row.eventId }));
  const coverage = prepared.rendered(rendered);
  assertEquals(coverage.required, [['*', '*']]);
  assert(coverage.members[f.bob.user_id]);
  assertThrows(() =>
    owner.required({ ...admission, roomId: '!another:localhost' }, {
      required: [],
      timeline: [],
      limited: false,
    })
  );
  assertEquals(
    owner.required(admission, { required: [], timeline: [], limited: false })
      .rows,
    [],
  );
  const lazy = owner.required(admission, {
    required: [['m.room.member', '$LAZY']],
    timeline: [{ sender: f.alice.user_id }],
    limited: false,
  });
  assertEquals(lazy.rows.map((row) => row.stateKey), [f.alice.user_id]);
  const prior = {
    cut: end,
    membership: 'join',
    config: { requiredState: coverage.required },
    members: coverage.members,
  };
  await f.send(
    'm.room.member',
    { membership: 'join', displayname: 'profile only' },
    f.bob.user_id,
    f.bob.user_id,
  );
  const after = await eventStreamMax(f.app.server);
  const continuous = await StateDelivery.capture(f.room, f.bob.user_id, {
    protocol: 'sliding',
    previous: prior,
  }, after);
  assertEquals(continuous.reason, 'continuous');
  const next = await admitState(f.room, {
    userId: f.bob.user_id,
    ceiling: after,
  });
  const delta = continuous.required(next, {
    required: [['*', '*']],
    timeline: [],
    limited: false,
  });
  assertEquals(delta.rows.map((row) => row.stateKey), [f.bob.user_id]);
  // A declined private invitation must not gain the custom snapshot on reset.
  const stranger = await suite.registerTestUser('delivery-coverage-c', 'pw');
  await invite(f.room, f.alice.user_id, stranger.user_id, f.signer);
  await leave(f.room, stranger.user_id, f.signer);
  const declinedCut = await eventStreamMax(f.app.server);
  const declined = await admitState(f.room, {
    userId: stranger.user_id,
    ceiling: declinedCut,
  });
  const noBaseline = await StateDelivery.capture(f.room, stranger.user_id, {
    protocol: 'ordinary',
    since: null,
    fullState: false,
  }, declinedCut);
  assert(
    !noBaseline.required(declined, {
      required: [['*', '*']],
      timeline: [],
      limited: false,
    }).rows.some((row) => row.eventId === f.custom),
  );
});

suite.test('a last-local-member archived reopen invalidates the old stay baseline in all paths', async () => {
  const f = await fixture('delivery-reopen');
  await join(f.room, f.bob.user_id, f.signer);
  await f.baseline();
  await leave(f.room, f.bob.user_id, f.signer);
  await leave(f.room, f.alice.user_id, f.signer);
  await reopen(f.room, f.bob.user_id, f.signer, {});
  for (const path of paths) {
    const entry = await f.sync(path);
    const state = path === 'legacy'
      ? events(obj(entry.state).events)
      : path === 'stable'
      ? events(obj(entry.state_after).events)
      : path === 'unstable'
      ? events(obj(entry['org.matrix.msc4222.state_after']).events)
      : events(entry.required_state);
    for (const id of [f.encryption, f.custom]) {
      assert(state.some((e) => e.event_id === id));
    }
  }
});

const transitions: {
  name: string;
  before(f: Fixture): Promise<unknown>;
  after(f: Fixture): Promise<unknown>;
  left?: boolean;
}[] = [
  {
    name: 'held-invite',
    before: (f) => invite(f.room, f.alice.user_id, f.bob.user_id, f.signer),
    after: (f) => join(f.room, f.bob.user_id, f.signer),
  },
  {
    name: 'knock-invite',
    before: async (f) => {
      await f.send('m.room.join_rules', { join_rule: 'knock' });
      await knock(f.room, f.bob.user_id, f.signer);
    },
    after: async (f) => {
      await invite(f.room, f.alice.user_id, f.bob.user_id, f.signer);
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'knock-direct',
    before: async (f) => {
      await f.send('m.room.join_rules', { join_rule: 'knock' });
      await knock(f.room, f.bob.user_id, f.signer);
    },
    after: async (f) => {
      await f.send('m.room.join_rules', { join_rule: 'public' });
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'leave-polled',
    before: async (f) => {
      await join(f.room, f.bob.user_id, f.signer);
      await leave(f.room, f.bob.user_id, f.signer);
    },
    after: (f) => join(f.room, f.bob.user_id, f.signer),
  },
  {
    name: 'kick-unpolled',
    before: (f) => join(f.room, f.bob.user_id, f.signer),
    after: async (f) => {
      await kick(f.room, f.alice.user_id, f.bob.user_id, f.signer);
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'ban-former',
    before: async (f) => {
      await join(f.room, f.bob.user_id, f.signer);
      await ban(f.room, f.alice.user_id, f.bob.user_id, f.signer);
    },
    after: async (f) => {
      await unban(f.room, f.alice.user_id, f.bob.user_id, f.signer);
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'ban-never',
    before: (f) => ban(f.room, f.alice.user_id, f.bob.user_id, f.signer),
    after: async (f) => {
      await unban(f.room, f.alice.user_id, f.bob.user_id, f.signer);
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'restricted',
    before: async (f) => {
      const allowed = await createRoom(f.app.store, {
        creator: f.alice.user_id,
        preset: 'public_chat',
      }, f.signer);
      await join(
        await openRoom(f.app.store, allowed.roomId),
        f.bob.user_id,
        f.signer,
      );
      await f.send('m.room.join_rules', {
        join_rule: 'restricted',
        allow: [{ type: 'm.room_membership', room_id: allowed.roomId }],
      });
    },
    after: (f) => join(f.room, f.bob.user_id, f.signer),
  },
  {
    name: 'replacement',
    before: async (f) => {
      const old = await createRoom(f.app.store, {
        creator: f.alice.user_id,
        preset: 'public_chat',
      }, f.signer);
      await join(
        await openRoom(f.app.store, old.roomId),
        f.bob.user_id,
        f.signer,
      );
      await sendLocal(await openRoom(f.app.store, old.roomId), {
        type: 'm.room.tombstone',
        state_key: '',
        sender: f.alice.user_id,
        content: { replacement_room: f.roomId, body: 'follow' },
      }, f.signer);
      await f.send('m.room.history_visibility', {
        history_visibility: 'world_readable',
      });
    },
    after: (f) => join(f.room, f.bob.user_id, f.signer),
  },
  ...[false, true].map((fetched) => ({
    name: 'preview-' + fetched,
    before: async (f: Fixture) => {
      await f.send('m.room.history_visibility', {
        history_visibility: 'world_readable',
      });
      if (fetched) {
        await call(
          f.bob.access_token!,
          '/_matrix/client/v3/rooms/' + encodeURIComponent(f.roomId) +
            '/initialSync?limit=0',
        );
      }
    },
    after: (f: Fixture) => join(f.room, f.bob.user_id, f.signer),
  })),
  {
    name: 'rapid-profile',
    before: (f) => join(f.room, f.bob.user_id, f.signer),
    after: async (f) => {
      await leave(f.room, f.bob.user_id, f.signer);
      await join(f.room, f.bob.user_id, f.signer);
      await f.send(
        'm.room.member',
        { membership: 'join', displayname: 'profile after rejoin' },
        f.bob.user_id,
        f.bob.user_id,
      );
    },
  },
  {
    name: 'resolved-absence',
    before: (f) => join(f.room, f.bob.user_id, f.signer),
    after: async (f) => {
      // Model a resolver publication removing the member without a leave PDU.
      // Use the real materialization owner at a non-state trigger's empty slot.
      const trigger = await sendLocal(f.room, {
        type: 'org.example.trigger',
        sender: f.alice.user_id,
        content: {},
      }, f.signer);
      await f.room.tx(async (tx) => {
        const stay = await tx.segments.openStay();
        const current = await tx.state.current(stay!.id);
        const group = await tx.materialize.newGroup(current, [{
          type: 'm.room.member',
          state_key: f.bob.user_id,
          event: null,
        }]);
        await tx.materialize.publish(
          (await tx.changes.posOf(trigger.eventId))!,
          stay!.id,
          group,
        );
        await tx.materialize.setCurrent(stay!.id, group);
      });
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'forgotten',
    before: async (f) => {
      await join(f.room, f.bob.user_id, f.signer);
      await leave(f.room, f.bob.user_id, f.signer);
      await call(
        f.bob.access_token!,
        '/_matrix/client/v3/rooms/' + encodeURIComponent(f.roomId) + '/forget',
        {},
      );
    },
    after: (f) =>
      call(
        f.bob.access_token!,
        '/_matrix/client/v3/rooms/' + encodeURIComponent(f.roomId) + '/join',
        {},
      ),
  },
  {
    name: 'decline-reinvite',
    before: async (f) => {
      await invite(f.room, f.alice.user_id, f.bob.user_id, f.signer);
      await leave(f.room, f.bob.user_id, f.signer);
    },
    after: async (f) => {
      await invite(f.room, f.alice.user_id, f.bob.user_id, f.signer);
      await join(f.room, f.bob.user_id, f.signer);
    },
  },
  {
    name: 'join-then-leave',
    before: (f) => invite(f.room, f.alice.user_id, f.bob.user_id, f.signer),
    after: async (f) => {
      await join(f.room, f.bob.user_id, f.signer);
      await leave(f.room, f.bob.user_id, f.signer);
      await f.send('org.example.delivery', { value: 'must not leak' }, 'later');
    },
    left: true,
  },
];

for (const transition of transitions) {
  let f: Fixture;
  suite.test(
    transition.name + ' setup with real pre-transition tokens',
    async () => {
      f = await fixture('delivery-' + transition.name);
      await transition.before(f);
      await f.baseline();
      await transition.after(f);
    },
  );
  for (const path of paths) {
    suite.test(
      transition.name + ' -> ' + path + ' delivers unchanged full keys',
      async () => {
        const entry = await f.sync(path, false, false, { full: false });
        const state = path === 'legacy'
          ? events(obj(entry.state).events)
          : path === 'stable'
          ? events(obj(entry.state_after).events)
          : path === 'unstable'
          ? events(obj(entry['org.matrix.msc4222.state_after']).events)
          : events(entry.required_state);
        const ids = state.map((e) => e.event_id);
        assert(
          ids.includes(f.encryption),
          'unchanged full encryption event missing',
        );
        assert(ids.includes(f.custom), 'unchanged unrelated state key missing');
        assert(
          state.some((e) =>
            e.type === 'm.room.member' && e.state_key === f.bob.user_id
          ),
          'own membership absent from zero-timeline reset',
        );
        assert(
          !JSON.stringify(entry).includes('must not leak'),
          'post-departure state leaked',
        );
        if (!['legacy', 'stable', 'unstable'].includes(path)) {
          assertEquals(entry.initial, true);
        }
      },
    );
  }
}

// The imported encryption/custom keys have no local timeline positions. A saved
// OOB invitation, an archived stay and a resident-vouched join are not receipts.
for (const mode of ['fresh', 'archived', 'restricted'] as const) {
  let f:
    & { roomId: string; encryption: string; custom: string }
    & ReturnType<typeof protocols>;
  suite.test(
    'federation-' + mode + ' setup with saved OOB prejoin tokens',
    async () => {
      const app = theApp();
      const bob = await suite.registerTestUser('delivery-remote-' + mode, 'pw');
      const signer = app.tenant.signer();
      const remote = await makeFakeRoom({
        roomId: '!delivery-' + mode + ':remote.test',
        joinRule: mode === 'restricted' ? 'restricted' : 'public',
      });
      const encryption = (await remote.addEvent({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      })).event_id!;
      const custom = (await remote.addEvent({
        type: 'org.example.delivery',
        state_key: 'key',
        content: { value: 'imported before since' },
      })).event_id!;
      const keys = fakeKeyResolver(
        remote.server,
        await testRemoteServer('localhost'),
      );
      const transport = fakeFetcher({
        makeJoin: (user) => {
          const result = remote.makeJoinAnswer(user);
          if (mode === 'restricted') {
            result.event.content.join_authorised_via_users_server =
              remote.creator;
          }
          return result;
        },
        sendJoin: (pdu) => remote.acceptSendJoin(pdu),
      });
      const importedJoin = () =>
        joinRemote(app.store, {
          roomId: remote.roomId,
          user: bob.user_id,
          via: [remote.server.name],
          signer,
          deps: { keys, fetcher: transport.fetcher, self: 'localhost' },
        });
      if (mode === 'archived') {
        await importedJoin();
        const held = await openRoom(app.store, remote.roomId);
        const left = await leave(held, bob.user_id, signer);
        const row = await held.tx((tx) => tx.events.get(left.eventId));
        await remote.acceptSendJoin(JSON.parse(row!.pdu));
      }
      const invitation = await remote.addEvent({
        type: 'm.room.member',
        state_key: bob.user_id,
        content: { membership: 'invite' },
      });
      await receiveInvite(
        remote.roomId,
        invitation.event_id!,
        {
          room_version: '11',
          event: wireOf(invitation),
          invite_room_state: [
            ...remote.afterOf.get(invitation.event_id!)!.values(),
          ].map((id) => {
            const pdu = remote.events.get(id)!;
            return {
              type: pdu.type,
              state_key: pdu.state_key,
              sender: pdu.sender,
              content: pdu.content,
            };
          }),
        },
        remote.server.name,
        {
          store: app.store,
          server: app.server,
          signer,
          keys,
          self: 'localhost',
          wake: () => {},
        },
      );
      f = {
        roomId: remote.roomId,
        encryption,
        custom,
        ...protocols('federation-' + mode, bob.access_token!, remote.roomId),
      };
      await f.baseline();
      await importedJoin();
    },
  );
  for (const path of paths) {
    suite.test(
      'federation-' + mode + ' -> ' + path + ' delivers imported full keys',
      async () => {
        const entry = await f.sync(path);
        const state = path === 'legacy'
          ? events(obj(entry.state).events)
          : path === 'stable'
          ? events(obj(entry.state_after).events)
          : path === 'unstable'
          ? events(obj(entry['org.matrix.msc4222.state_after']).events)
          : events(entry.required_state);
        for (const id of [f.encryption, f.custom]) {
          assert(
            state.some((e) => e.event_id === id),
            'imported full state missing: ' + path,
          );
        }
        if (!['legacy', 'stable', 'unstable'].includes(path)) {
          assertEquals(entry.initial, true);
        }
      },
    );
  }
}
