import { assert, assertEquals, assertRejects } from '@std/assert';
import { eduState } from '#engine/federation/edus.ts';
import {
  makeJoin,
  makeKnock,
  makeLeave,
  sendJoin,
  sendKnock,
  sendLeave,
} from '#engine/federation/joins.ts';
import {
  serveBackfill,
  serveEvent,
  serveEventAuth,
  serveGetMissingEvents,
  serveState,
  serveStateIds,
  serveTimestamp,
} from '#engine/federation/serve.ts';
import {
  type InviteDeps,
  inviteRemote,
  receiveInvite,
} from '#engine/federation/invites.ts';
import { productionFetcher } from '#engine/federation/fetcher.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { redactEvent, sendLocal } from '#engine/room/ingest.ts';
import { aclAllows, serverAllowed } from '#engine/room/acl.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { bobJoins, type Genesis, genesis } from './fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';
import { authAt } from './fixtures/auth.ts';

installServerHooks();

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function deny(g: Genesis) {
  return await sendLocal(g.room, {
    type: 'm.room.server_acl',
    state_key: '',
    sender: g.creator,
    content: { allow: ['*'], deny: ['REMOTE.TEST'] },
  }, g.signer);
}

Deno.test('ACL: all resident serving and membership template classes use current published state', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!acl:test', joinRule: 'public' });
    await bobJoins(g, '@bob:remote.test');
    const server = await store.server();
    const deps = { store, server, self: g.signer.serverName };
    const membership = { ...deps, signer: g.signer } as InviteDeps;
    const readers = [
      () => serveStateIds(g.roomId, g.tipId, 'remote.test', deps),
      () => serveState(g.roomId, g.tipId, 'remote.test', deps),
      () => serveEvent(g.tipId, 'remote.test', deps),
      () => serveEventAuth(g.roomId, g.tipId, 'remote.test', deps),
      () => serveBackfill(g.roomId, [g.tipId], 10, 'remote.test', deps),
      () => serveTimestamp(g.roomId, { ts: 0, dir: 'f' }, 'remote.test', deps),
      () =>
        serveGetMissingEvents(
          g.roomId,
          { earliest_events: [], latest_events: [g.tipId] },
          'remote.test',
          deps,
        ),
      () =>
        makeJoin(
          g.roomId,
          '@bob:remote.test',
          'remote.test',
          ['11'],
          membership,
        ),
      () =>
        makeLeave(g.roomId, '@bob:remote.test', 'remote.test', [], membership),
    ];
    for (const read of readers) await read();
    await deny(g);
    for (
      const deniedKnock of [
        () =>
          makeKnock(
            g.roomId,
            '@knocker:remote.test',
            'remote.test',
            ['11'],
            membership,
          ),
        () => sendKnock(g.roomId, '$missing', {}, 'remote.test', membership),
      ]
    ) {
      const error = await assertRejects(deniedKnock, MatrixError);
      assertEquals(error.status, 403);
      assertEquals(error.message, 'M_FORBIDDEN: server denied by room ACL');
    }
    for (const read of readers) {
      const error = await assertRejects(read, MatrixError);
      assertEquals(error.status, 403);
      assertEquals(error.errcode, 'M_FORBIDDEN');
    }
    for (const v of ['v1', 'v2'] as const) {
      for (const send of [sendJoin, sendLeave]) {
        assertEquals(
          (await assertRejects(
            () => send(g.roomId, '$missing', {}, 'remote.test', v, membership),
            MatrixError,
          )).status,
          403,
        );
      }
    }
    assertEquals(
      (await assertRejects(
        () =>
          receiveInvite(g.roomId, '$missing', {}, 'remote.test', membership),
        MatrixError,
      )).status,
      403,
    );
    assertEquals(
      (await assertRejects(() =>
        inviteRemote(
          g.roomId,
          g.creator,
          '@new:remote.test',
          undefined,
          undefined,
          membership,
        ), MatrixError)).status,
      403,
    );
    const fetcher = productionFetcher(server, g.signer, store);
    // Local policy denials propagate through each shared read boundary.
    for (
      const read of [
        () => fetcher.event(g.tipId, 'remote.test', g.roomId),
        () => fetcher.stateIds(g.roomId, g.tipId, 'remote.test'),
        () => fetcher.eventAuth(g.roomId, g.tipId, 'remote.test'),
      ]
    ) {
      const error = await assertRejects(read, MatrixError);
      assertEquals(error.status, 403);
      assertEquals(error.errcode, 'M_FORBIDDEN');
    }
    assertEquals(
      (await assertRejects(
        () => fetcher.backfill(g.roomId, [g.tipId], 10, 'remote.test'),
        MatrixError,
      ))
        .status,
      403,
    );
    assertEquals(
      (await assertRejects(
        () => fetcher.missingEvents(g.roomId, [], [g.tipId], 10, 'remote.test'),
        MatrixError,
      )).status,
      403,
    );
    assertEquals(
      (await assertRejects(
        () => fetcher.makeJoin(g.roomId, g.creator, ['11'], 'remote.test'),
        MatrixError,
      )).status,
      403,
    );
    // No cached decision: a new publication permits the origin again.
    await sendLocal(g.room, {
      type: 'm.room.server_acl',
      state_key: '',
      sender: g.creator,
      content: { allow: ['*'] },
    }, g.signer);
    for (const read of readers) await read();
  });
});

Deno.test('ACL: denied room PDUs and EDU entries do not prevent allowed-room traffic', async () => {
  await withStore(async (store) => {
    const blocked = await genesis(store, {
      roomId: '!blocked:test',
      joinRule: 'public',
    });
    const allowed = await genesis(store, {
      roomId: '!allowed:test',
      joinRule: 'public',
    });
    const user = '@bob:remote.test';
    for (const g of [blocked, allowed]) await bobJoins(g, user);
    await deny(blocked);
    const remote = await makeRemoteServer('remote.test');
    const pdus: Pdu[] = [];
    for (const g of [blocked, allowed]) {
      const tip = await g.room.tx(async (tx) =>
        (await tx.extremities.frontier((await tx.segments.openStay())!.id))[0]
      );
      pdus.push(
        await remoteEvent(g.roomId, remote, '11', {
          type: 'm.room.message',
          sender: user,
          content: { body: 'sentinel', msgtype: 'm.text' },
          prev_events: [tip],
          auth_events: await authAt(g.room, {
            type: 'm.room.message',
            sender: user,
            content: {},
          }, tip),
        }),
      );
    }
    const server = await store.server();
    const edus = eduState(server, blocked.signer.serverName, store);
    let deviceTraffic = 0;
    edus.register('m.direct_to_device', () => {
      deviceTraffic++;
      return Promise.resolve();
    }, true);
    const result = await receiveTransaction(remote.name, 'acl-mixed', {
      origin: remote.name,
      origin_server_ts: Date.now(),
      pdus,
      edus: [
        {
          edu_type: 'm.direct_to_device',
          content: { room_id: blocked.roomId },
        },
        ...[blocked, allowed].map((g) => ({
          edu_type: 'm.typing',
          content: { room_id: g.roomId, user_id: user, typing: true },
        })),
        {
          edu_type: 'm.receipt',
          content: Object.fromEntries(
            [blocked, allowed].map((
              g,
              i,
            ) => [g.roomId, {
              'm.read': {
                [user]: {
                  event_ids: [String(pdus[i].event_id)],
                  data: { ts: 42, thread_id: 'main' },
                },
              },
            }]),
          ),
        },
      ],
    }, {
      store,
      keys: fakeKeyResolver(remote),
      fetcher: fakeFetcher({}).fetcher,
      self: blocked.signer.serverName,
      edus,
    });
    const outcomes = result.body.pdus as Record<string, { error?: string }>;
    assert(outcomes[String(pdus[0].event_id)].error);
    assertEquals(outcomes[String(pdus[1].event_id)], {});
    assertEquals(edus.typingOf(blocked.roomId).userIds, []);
    assertEquals(edus.typingOf(allowed.roomId).userIds, [user]);
    assertEquals(await edus.receiptsIn(blocked.roomId), []);
    assertEquals((await edus.receiptsIn(allowed.roomId))[0].threadId, 'main');
    assertEquals(deviceTraffic, 1);
    assertEquals(
      await blocked.room.tx((tx) => tx.events.get(String(pdus[0].event_id))),
      null,
    );
  });
});

Deno.test('ACL: defaults, whole case-insensitive globs, literal regex characters, ports and IPs', () => {
  const cases: [string, unknown, boolean][] = [
    ['remote.test', null, true],
    ['remote.test', {}, false],
    ['remote.test', { allow: [] }, false],
    ['remote.test', { deny: [] }, false],
    ['remote.test', { allow: ['*'], deny: ['*'] }, false],
    ['REMOTE.TEST:8448', { allow: ['remote.test'] }, true],
    ['remote.test:8448', { allow: ['remote.test:8448'] }, false],
    ['x.remote.test', { allow: ['remote.test'] }, false],
    ['remoteXtest', { allow: ['remote.test'] }, false],
    ['a.remote.test', { allow: ['?.remote.test'] }, true],
    ['ab.remote.test', { allow: ['?.remote.test'] }, false],
    ['remote.test', { allow: ['*'], deny: ['ReMoTe.*'] }, false],
    ['1.2.3.4:8448', { allow: ['*'], allow_ip_literals: false }, false],
    ['1.2.3.4:8448', { allow: ['1.2.3.4'] }, true],
    ['[2001:db8::1]:8448', { allow: ['*'], allow_ip_literals: false }, false],
    ['[2001:db8::1]:8448', { allow: ['[2001:db8::1]'] }, true],
    ['[::ffff:192.0.2.1]', { allow: ['*'], allow_ip_literals: false }, false],
    ['[::1]', null, true],
    ['::1', null, false],
    ['remote.test:bad', null, false],
    ['remote.test:0', null, false],
    ['remote.test:65536', null, false],
    ['[nope]', null, false],
    ['remote.test', { allow: [null, 1, '*'], deny: [true] }, true],
  ];
  for (const [server, acl, expected] of cases) {
    assertEquals(
      serverAllowed(server, acl),
      expected,
      JSON.stringify([server, acl]),
    );
  }
});

Deno.test('ACL: an accepted ACL change in the same transaction refuses later PDUs', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!batch:test',
      joinRule: 'public',
    });
    const remote = await makeRemoteServer('remote.test');
    const user = '@bob:remote.test';
    await bobJoins(g, user);
    const pl = await sendLocal(g.room, {
      type: 'm.room.power_levels',
      state_key: '',
      sender: g.creator,
      content: { users: { [user]: 100, [g.creator]: 100 } },
    }, g.signer);
    const acl = await remoteEvent(g.roomId, remote, '11', {
      type: 'm.room.server_acl',
      state_key: '',
      sender: user,
      content: { allow: ['*'], deny: ['remote.test'] },
      prev_events: [pl.eventId],
      auth_events: await authAt(g.room, {
        type: 'm.room.server_acl',
        state_key: '',
        sender: user,
        content: {},
      }, pl.eventId),
    });
    const message = await remoteEvent(g.roomId, remote, '11', {
      type: 'm.room.message',
      sender: user,
      content: { msgtype: 'm.text', body: 'must be refused' },
      prev_events: [String(acl.event_id)],
      auth_events: await authAt(g.room, {
        type: 'm.room.message',
        sender: user,
        content: {},
      }, pl.eventId),
    });
    const server = await store.server();
    const result = await receiveTransaction(remote.name, 'acl-change', {
      origin: remote.name,
      origin_server_ts: Date.now(),
      pdus: [acl, message],
    }, {
      store,
      keys: fakeKeyResolver(remote),
      fetcher: fakeFetcher({}).fetcher,
      self: g.signer.serverName,
      edus: eduState(server, g.signer.serverName, store),
    });
    const pdus = result.body.pdus as Record<string, { error?: string }>;
    assertEquals(pdus[String(acl.event_id)], {});
    assert(pdus[String(message.event_id)].error);
    assertEquals(
      await g.room.tx((tx) => tx.events.get(String(message.event_id))),
      null,
    );
  });
});

Deno.test('ACL: redaction effects are read from room truth before server projection', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!redaction:test' });
    const acl = await sendLocal(g.room, {
      type: 'm.room.server_acl',
      state_key: '',
      sender: g.creator,
      content: { allow: ['*'] },
    }, g.signer);
    assertEquals(await g.room.tx((tx) => aclAllows(tx, 'remote.test')), true);
    await redactEvent(g.room, g.creator, acl.eventId, g.signer);
    assertEquals(await g.room.tx((tx) => aclAllows(tx, 'remote.test')), false);
  });
});

Deno.test('ACL: a membership dance rechecks admission after asynchronous signature verification', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!race:test',
      joinRule: 'public',
    });
    const remote = await makeRemoteServer('remote.test');
    const deps = {
      store,
      server: await store.server(),
      self: g.signer.serverName,
      signer: g.signer,
    } as InviteDeps;
    const template = await makeJoin(g.roomId, '@bob:remote.test', remote.name, [
      '11',
    ], deps);
    const pdu = await remoteEvent(g.roomId, remote, '11', template.event);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const keys = fakeKeyResolver(remote);
    deps.keys = {
      verifyEventSignature: async (args) => {
        entered.resolve();
        await release.promise;
        return await keys.verifyEventSignature(args);
      },
    };
    const answer = assertRejects(
      () =>
        sendJoin(g.roomId, String(pdu.event_id), pdu, remote.name, 'v2', deps),
      MatrixError,
    );
    await entered.promise;
    try {
      await deny(g);
    } finally {
      release.resolve();
    }
    assertEquals((await answer).status, 403);
    assertEquals(
      await g.room.tx((tx) => tx.events.get(String(pdu.event_id))),
      null,
    );
  });
});

Deno.test('ACL: room-scoped federation endpoint inventory has an admitted engine owner', async () => {
  const root = 'api/endpoints/matrix/_matrix/federation';
  const owners: Record<string, string> = {
    'v1/backfill/#roomId/get.ts': 'serveBackfill',
    'v1/event/#eventId/get.ts': 'serveEvent',
    'v1/event_auth/#roomId/#eventId/get.ts': 'serveEventAuth',
    'v1/get_missing_events/#roomId/post.ts': 'serveGetMissingEvents',
    'v1/make_join/#roomId/#userId/get.ts': 'makeJoin',
    'v1/make_leave/#roomId/#userId/get.ts': 'makeLeave',
    'v1/make_knock/#roomId/#userId/get.ts': 'makeKnock',
    'v1/send_join/#roomId/#eventId/put.ts': 'sendJoin',
    'v2/send_join/#roomId/#eventId/put.ts': 'sendJoin',
    'v1/send_leave/#roomId/#eventId/put.ts': 'sendLeave',
    'v2/send_leave/#roomId/#eventId/put.ts': 'sendLeave',
    'v1/send_knock/#roomId/#eventId/put.ts': 'sendKnock',
    'v2/invite/#roomId/#eventId/put.ts': 'receiveInvite',
    'v1/state/#roomId/get.ts': 'serveState',
    'v1/state_ids/#roomId/get.ts': 'serveStateIds',
    'v1/timestamp_to_event/#roomId/get.ts': 'serveTimestamp',
    'v1/hierarchy/#roomId/get.ts': 'federationHierarchy',
  };
  const found: string[] = [];
  async function walk(prefix: string) {
    for await (const entry of Deno.readDir(root + '/' + prefix)) {
      const path = prefix + entry.name;
      if (entry.isDirectory) await walk(path + '/');
      else if (
        (path.includes('/#roomId/') || path === 'v1/event/#eventId/get.ts') &&
        /\/(get|post|put)\.ts$/.test(path)
      ) {
        found.push(path);
        assert(
          owners[path],
          'New room endpoint requires an ACL consumer test: ' + path,
        );
        assert(
          (await Deno.readTextFile(root + '/' + path)).includes(
            owners[path] + '(',
          ),
          path,
        );
      }
    }
  }
  await walk('');
  assertEquals(found.sort(), Object.keys(owners).sort());
});

Deno.test('ACL: resident delivery is retained while denied-self new participation is refused', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, {
      roomId: '!delivery:test',
      joinRule: 'public',
    });
    await bobJoins(g, '@bob:remote.test');
    await sendLocal(g.room, {
      type: 'm.room.server_acl',
      state_key: '',
      sender: g.creator,
      content: { allow: ['*'], deny: ['remote.test', g.signer.serverName] },
    }, g.signer);
    const message = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: {
        msgtype: 'm.text',
        body: 'existing residents still receive this',
      },
    }, g.signer);
    assertEquals(message.standing, 'accepted');
    assertEquals(
      (await (await store.server()).query(
        'SELECT state FROM outbox WHERE room=? AND event=? AND destination=?',
        [g.roomId, message.eventId, 'remote.test'],
      ))[0].state,
      'pending',
    );
    const user = '@other:' + g.signer.serverName;
    const error = await assertRejects(
      () =>
        sendLocal(g.room, {
          type: 'm.room.member',
          state_key: user,
          sender: user,
          content: { membership: 'join' },
        }, g.signer),
      MatrixError,
    );
    assertEquals(error.status, 403);
  });
});
