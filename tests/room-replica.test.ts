import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  exportReplicaBoundary,
  exportReplicaRoom,
  importReplicaBoundary,
  importReplicaGenesis,
  importReplicaRoom,
  type ReplicaRoom,
} from '#engine/room/replica.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { backfill } from '#engine/room/history.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { openStore } from '#engine/store/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';

async function roundTrip(
  f: Awaited<ReturnType<typeof fixture>>,
  manifest: ReplicaRoom,
) {
  const dir = await Deno.makeTempDir({ prefix: 'whole-room-replica-' });
  const destination = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await importReplicaRoom(destination, manifest, {
      self: f.input.self,
      keys: f.input.keys,
    });
    const replica = await openRoom(destination, manifest.roomId);
    const actual = await exportReplicaRoom(replica, f.input.self);
    assertEquals(actual.stays, manifest.stays);
    assertEquals(
      new Set(actual.events.map((pdu) => String(pdu.event_id))),
      new Set(manifest.events.map((pdu) => String(pdu.event_id))),
    );
    const source = await openRoom(f.store, manifest.roomId);
    for (const step of manifest.steps) {
      const state = (room: typeof replica) =>
        room.tx(async (tx) => {
          const before = await tx.state.eventStateBefore(step.eventId);
          return {
            status: (await tx.events.getStatus(step.eventId))?.standing,
            before: before === null
              ? null
              : await tx.state.groupMap(before.group),
            positioned: await tx.segments.positionOf(step.eventId) !== null,
          };
        });
      assertEquals(await state(replica), await state(source));
    }
    const head = await replica.tx((tx) => tx.changes.head());
    await importReplicaRoom(destination, manifest, {
      self: f.input.self,
      keys: f.input.keys,
    });
    assertEquals(await replica.tx((tx) => tx.changes.head()), head);
  } finally {
    await destination.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function fixture(
  options: { priorLocal?: boolean; deny?: string[] } = {},
) {
  const source = await makeFakeRoom({ roomId: '!replica:remote.test' });
  const home = await makeRemoteServer('logical.test');
  if (options.priorLocal) {
    await source.addEvent({
      type: 'm.room.member',
      sender: '@prior:logical.test',
      state_key: '@prior:logical.test',
      content: { membership: 'join' },
    });
  }
  if (options.deny) {
    await source.addEvent({
      type: 'm.room.server_acl',
      state_key: '',
      content: { allow: ['*'], deny: options.deny, allow_ip_literals: true },
    });
  }
  const template = source.makeJoinAnswer('@alice:logical.test').event;
  const join = await remoteEvent(source.roomId, home, source.version, {
    ...template,
    sender: '@alice:logical.test',
    prev_events: template.prev_events ?? [],
  });
  const answer = await source.acceptSendJoin(join);
  const dir = await Deno.makeTempDir({ prefix: 'room-replica-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  return {
    store,
    source,
    home,
    join,
    input: {
      roomId: source.roomId,
      roomVersion: source.version,
      self: 'logical.test',
      resident: source.server.name,
      keys: fakeKeyResolver(source.server, home),
      join: answer.event,
      state: answer.state,
      authChain: answer.authChain,
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('replica imports the authentic local participation boundary without minting a new join or copying state IDs', async () => {
  const f = await fixture();
  try {
    const imported = await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const first = await room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      assert(stay);
      assertEquals(stay.opened_by, f.join.event_id);
      assertEquals(
        (await tx.events.get(String(f.join.event_id)))!.pdu,
        canonicalJson(f.input.join),
      );
      const before = await tx.state.eventStateBefore(String(f.join.event_id));
      assert(before !== null);
      assertEquals(before.provenance, 'imported');
      assertEquals(
        await tx.state.groupMap(before.group),
        new Map(
          f.input.state.map((
            event,
          ) => [event.type + '\0' + event.state_key, String(event.event_id)]),
        ),
      );
      assertEquals(
        (await tx.events.getStatus(String(f.join.event_id)))?.grounding,
        'grounded',
      );
      return { changes: await tx.changes.head(), stay: stay.id };
    });
    assertEquals(imported.eventId, f.join.event_id);
    await importReplicaBoundary(f.store, f.input);
    assertEquals(
      await room.tx(async (tx) => ({
        changes: await tx.changes.head(),
        stay: (await tx.segments.openStay())!.id,
      })),
      first,
    );
  } finally {
    await f.close();
  }
});

Deno.test('replica refuses unsigned own joins, non-local participation and missing closure before creating a room', async () => {
  const f = await fixture();
  try {
    await assertRejects(() =>
      importReplicaBoundary(f.store, {
        ...f.input,
        join: { ...f.input.join, signatures: {} },
      })
    );
    await assertRejects(() =>
      importReplicaBoundary(f.store, {
        ...f.input,
        join: {
          ...f.input.join,
          signatures: {
            [f.source.server.name]:
              f.input.join.signatures![f.source.server.name],
          },
        },
      })
    );
    await assertRejects(
      () =>
        importReplicaBoundary(f.store, { ...f.input, self: 'unrelated.test' }),
      MatrixError,
      'local participation',
    );
    await assertRejects(
      () =>
        importReplicaBoundary(f.store, {
          ...f.input,
          state: f.input.state.filter((pdu) => pdu.type !== 'm.room.create'),
        }),
      MatrixError,
    );
    await assertRejects(
      () => openRoom(f.store, f.source.roomId),
      Deno.errors.NotFound,
    );
  } finally {
    await f.close();
  }
});

Deno.test('a signed participation event still needs authorization against its imported before-state', async () => {
  const f = await fixture();
  try {
    const ban = await f.source.addEvent({
      type: 'm.room.member',
      state_key: '@alice:logical.test',
      content: { membership: 'ban' },
    });
    await assertRejects(
      () =>
        importReplicaBoundary(f.store, {
          ...f.input,
          state: [
            ...f.input.state.filter((pdu) =>
              !(pdu.type === 'm.room.member' &&
                pdu.state_key === '@alice:logical.test')
            ),
            ban,
          ],
          authChain: [...f.source.events.values()],
        }),
      MatrixError,
      'snapshot state',
    );
    await assertRejects(
      () => openRoom(f.store, f.source.roomId),
      Deno.errors.NotFound,
    );
  } finally {
    await f.close();
  }
});

Deno.test('home-created replica genesis replays the original create and creator join through normal DAG state', async () => {
  const f = await fixture();
  try {
    const home = await makeRemoteServer('logical.test');
    const source = await makeFakeRoom({
      roomId: '!local:logical.test',
      server: home,
    });
    const create = source.events.get(source.createId)!;
    const join = [...source.events.values()].find((pdu) =>
      pdu.type === 'm.room.member'
    )!;
    const input = {
      roomId: source.roomId,
      roomVersion: source.version,
      self: home.name,
      keys: fakeKeyResolver(home),
      create,
      join,
    };
    await importReplicaGenesis(f.store, input);
    const room = await openRoom(f.store, source.roomId);
    const read = () =>
      room.tx(async (tx) => {
        assertEquals(
          (await tx.state.eventStateBefore(source.createId))?.provenance,
          'dag',
        );
        const before = await tx.state.eventStateBefore(String(join.event_id));
        assert(before);
        assertEquals(before.provenance, 'dag');
        assertEquals(
          await tx.state.groupMap(before.group),
          new Map([['m.room.create\0', source.createId]]),
        );
        assert(await tx.segments.positionOf(source.createId));
        assert(await tx.segments.positionOf(String(join.event_id)));
        return await tx.changes.head();
      });
    const before = await read();
    await importReplicaGenesis(f.store, input);
    assertEquals(await read(), before);
  } finally {
    await f.close();
  }
});

Deno.test('replica boundary export pins original before-state and complete auth closure at one room cut', async () => {
  const f = await fixture();
  try {
    await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const exported = await exportReplicaBoundary(
      room,
      String(f.join.event_id),
      f.input.self,
    );
    assertEquals(exported.roomId, f.source.roomId);
    assertEquals(exported.roomVersion, f.source.version);
    assertEquals(
      new Set(exported.state.map((pdu) => String(pdu.event_id))),
      new Set(f.input.state.map((pdu) => String(pdu.event_id))),
    );
    assert(
      !exported.state.some((pdu) => pdu.state_key === '@alice:logical.test'),
    );
    assertEquals(exported.cut, await room.tx((tx) => tx.changes.head()));
    assert(!('opening_group' in exported));
    const closure = new Map(
      exported.authChain.map((pdu) => [String(pdu.event_id), pdu]),
    );
    for (
      const pdu of [...exported.state, exported.join, ...exported.authChain]
    ) {
      for (const id of pdu.auth_events ?? []) assert(closure.has(id));
    }
    const dir = await Deno.makeTempDir({ prefix: 'room-replica-destination-' });
    const destination = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { room: roomSchema } });
    try {
      await importReplicaBoundary(destination, {
        ...exported,
        keys: f.input.keys,
        self: f.input.self,
        resident: f.input.resident,
      });
      const replica = await openRoom(destination, f.source.roomId);
      const before = await replica.tx((tx) =>
        tx.state.eventStateBefore(String(f.join.event_id))
      );
      assert(before);
      assertEquals(
        await replica.tx((tx) => tx.state.groupMap(before.group)),
        new Map(
          exported.state.map((
            pdu,
          ) => [pdu.type + '\0' + pdu.state_key, String(pdu.event_id)]),
        ),
      );
    } finally {
      await destination.close();
      await Deno.remove(dir, { recursive: true });
    }
  } finally {
    await f.close();
  }
});

Deno.test('whole-room export retains participation, authorized history and exact imported before-state without local row IDs', async () => {
  const f = await fixture();
  try {
    await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const fetch = fakeFetcher({
      backfill: f.source.backfillPdus(
        f.join.prev_events!,
        f.source.events.size,
      ),
    });
    const history = await backfill(room, {
      from: f.join.prev_events!,
      limit: f.source.events.size,
      via: f.source.server.name,
    }, { keys: f.input.keys, fetcher: fetch.fetcher });
    assert(history.positioned.length > 0);
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'retained live', msgtype: 'm.text' },
    });
    await ingestRemote(room, [message], f.source.server.name, {
      keys: f.input.keys,
      fetcher: fakeFetcher({}).fetcher,
      self: f.input.self,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    const manifest = await exportReplicaRoom(room, f.input.self);
    assertEquals(manifest.cut, await room.tx((tx) => tx.changes.head()));
    assertEquals(manifest.stays.map((stay) => stay.opening.eventId), [
      f.join.event_id,
    ]);
    assertEquals(manifest.stays[0].opening.kind, 'join');
    assert(manifest.steps.some((step) => step.kind === 'history'));
    assert(
      manifest.steps.some((step) =>
        step.kind === 'live' && step.eventId === message.event_id
      ),
    );
    const boundary = manifest.boundaries.find((boundary) =>
      boundary.eventId === f.join.event_id
    );
    assert(boundary);
    assertEquals(
      new Set(boundary.state),
      new Set(f.input.state.map((pdu) => String(pdu.event_id))),
    );
    const events = new Map(
      manifest.events.map((pdu) => [String(pdu.event_id), pdu]),
    );
    assertEquals(events.get(String(message.event_id)), message);
    for (const pdu of events.values()) {
      for (const id of pdu.auth_events ?? []) assert(events.has(id));
    }
    const serialized = JSON.stringify(manifest);
    for (
      const field of [
        'opening_group',
        'current_group',
        'before_group',
        'after_group',
        'offset',
        'change_pos',
      ]
    ) {
      assert(!serialized.includes('"' + field + '"'));
    }
    await roundTrip(f, manifest);
    const oldCut = manifest.cut;
    const suffix = await f.source.addEvent({
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'suffix' },
    });
    await ingestRemote(room, [suffix], f.source.server.name, {
      keys: f.input.keys,
      fetcher: fakeFetcher({}).fetcher,
      self: f.input.self,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    const next = await exportReplicaRoom(room, f.input.self);
    assert(next.cut > oldCut);
    assert(!manifest.events.some((pdu) => pdu.event_id === suffix.event_id));
    assertEquals(JSON.stringify(manifest), serialized);
  } finally {
    await f.close();
  }
});

Deno.test('whole-room export includes older departed stays and isolated historical gap boundaries', async () => {
  const f = await fixture();
  try {
    await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const hidden = await f.source.addEvent({
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'history only' },
    });
    const anchor = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'isolated history', msgtype: 'm.text' },
    });
    const ids = f.source.stateIdsAt(String(anchor.event_id))!;
    await backfill(room, {
      from: [String(anchor.event_id)],
      limit: 1,
      via: f.source.server.name,
      anchor,
    }, {
      keys: f.input.keys,
      fetcher: fakeFetcher({
        stateIds: new Map([[String(anchor.event_id), ids]]),
        event: f.source.events,
      }).fetcher,
    });
    const kicked = await f.source.addEvent({
      type: 'm.room.member',
      state_key: '@alice:logical.test',
      content: { membership: 'leave' },
    });
    const missing = fakeFetcher({
      missingEvents: [hidden, anchor],
      event: f.source.events,
    });
    await ingestRemote(room, [kicked], f.source.server.name, {
      keys: f.input.keys,
      fetcher: missing.fetcher,
      self: f.input.self,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    assertEquals(await room.tx((tx) => tx.segments.openStay()), null);
    const template = f.source.makeJoinAnswer('@alice:logical.test').event;
    const rejoin = await remoteEvent(
      f.source.roomId,
      f.home,
      f.source.version,
      {
        ...template,
        prev_events: template.prev_events!,
      },
    );
    const answer = await f.source.acceptSendJoin(rejoin);
    await importReplicaBoundary(f.store, {
      ...f.input,
      join: answer.event,
      state: answer.state,
      authChain: answer.authChain,
    });
    const manifest = await exportReplicaRoom(room, f.input.self);
    assertEquals(
      manifest.stays.map((stay) => [stay.opening.eventId, stay.closed]),
      [
        [f.join.event_id, true],
        [rejoin.event_id, false],
      ],
    );
    assert(
      manifest.steps.some((step) =>
        step.kind === 'history' && step.anchor === anchor.event_id &&
        step.stay === f.join.event_id
      ),
    );
    const boundary = manifest.boundaries.find((entry) =>
      entry.eventId === anchor.event_id
    );
    assert(boundary);
    assertEquals(boundary.state, ids.pduIds);
    assert(
      manifest.boundaries.some((entry) => entry.eventId === rejoin.event_id),
    );
    await roundTrip(f, manifest);
  } finally {
    await f.close();
  }
});

Deno.test('whole-room replay rebuilds home genesis and live recovery gaps through ordinary ingest', async () => {
  const f = await fixture();
  try {
    const source = await makeFakeRoom({
      roomId: '!genesis:logical.test',
      server: f.home,
    });
    const pdus = [...source.events.values()];
    await importReplicaGenesis(f.store, {
      ...f.input,
      roomId: source.roomId,
      create: pdus[0],
      join: pdus[1],
    });
    const room = await openRoom(f.store, source.roomId);
    await ingestRemote(room, pdus.slice(2), f.home.name, {
      keys: f.input.keys,
      fetcher: fakeFetcher({}).fetcher,
      self: f.input.self,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    await source.addEvent({
      type: 'm.room.topic',
      state_key: '',
      content: { topic: 'retained evidence only' },
    });
    const parent = await source.addEvent({
      type: 'm.room.message',
      content: { body: 'gap parent' },
    });
    const tip = await source.addEvent({
      type: 'm.room.message',
      content: { body: 'gap tip' },
    });
    const latest = await source.addEvent({
      type: 'm.room.message',
      content: { body: 'live' },
    });
    await ingestRemote(room, [latest], f.home.name, {
      keys: f.input.keys,
      self: f.input.self,
      fetcher: fakeFetcher({
        missingEvents: [tip],
        event: source.events,
        stateIds: new Map([[
          String(parent.event_id),
          source.stateIdsAt(String(parent.event_id))!,
        ]]),
      }).fetcher,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    });
    assertEquals(
      (await room.tx((tx) =>
        tx.state.eventStateBefore(String(parent.event_id))
      ))?.provenance,
      'imported',
    );
    const manifest = await exportReplicaRoom(room, f.input.self);
    assertEquals(manifest.stays[0].opening.kind, 'genesis');
    await roundTrip(f, manifest);
  } finally {
    await f.close();
  }
});

Deno.test('whole-room replay refuses tampering and missing before-state rather than completing a partial replica', async () => {
  const f = await fixture();
  const dir = await Deno.makeTempDir({ prefix: 'replica-refusal-' });
  const destination = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await importReplicaBoundary(f.store, f.input);
    const source = await openRoom(f.store, f.source.roomId);
    const manifest = await exportReplicaRoom(source, f.input.self);
    const tampered = structuredClone(manifest);
    tampered.events.find((pdu) => pdu.event_id === f.join.event_id)!
      .signatures = {};
    await assertRejects(() =>
      importReplicaRoom(destination, tampered, f.input)
    );
    await assertRejects(
      () => openRoom(destination, f.source.roomId),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () =>
        importReplicaRoom(
          destination,
          { ...manifest, boundaries: [] },
          f.input,
        ),
      MatrixError,
      'before-state',
    );
    await assertRejects(
      () => openRoom(destination, f.source.roomId),
      Deno.errors.NotFound,
    );
    await importReplicaRoom(destination, manifest, f.input);
    const replica = await openRoom(destination, f.source.roomId);
    const before = await replica.tx((tx) =>
      tx.state.eventStateBefore(String(f.join.event_id))
    );
    assert(before);
  } finally {
    await destination.close();
    await Deno.remove(dir, { recursive: true });
    await f.close();
  }
});

Deno.test('whole-room replay preserves resident-vouched local snapshot evidence without accepting a resident-only participation join', async () => {
  const f = await fixture({ priorLocal: true });
  try {
    await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const manifest = await exportReplicaRoom(room, f.input.self);
    const prior = manifest.events.find((pdu) =>
      pdu.sender === '@prior:logical.test'
    )!;
    assert(prior);
    assertEquals(prior.signatures[f.input.self], undefined);
    await roundTrip(f, manifest);
    const tampered = structuredClone(manifest);
    const opening = tampered.events.find((pdu) =>
      pdu.event_id === f.join.event_id
    )!;
    delete opening.signatures[f.input.self];
    await assertRejects(() => roundTrip(f, tampered));
  } finally {
    await f.close();
  }
});

Deno.test('whole-room boundary preserves independently vouched state through a different opening resident', async () => {
  const f = await fixture({ priorLocal: true });
  try {
    const residents = new Map(
      [...f.input.state, ...f.input.authChain].map((
        pdu,
      ) => [String(pdu.event_id), f.input.resident]),
    );
    const input = { ...f.input, resident: 'different-relayer.test', residents };
    await importReplicaBoundary(f.store, input);
    const room = await openRoom(f.store, f.source.roomId);
    const manifest = await exportReplicaRoom(room, f.input.self);
    const prior = manifest.events.find((pdu) =>
      pdu.sender === '@prior:logical.test'
    )!;
    assert(prior);
    assertEquals(manifest.residents[String(prior.event_id)], f.input.resident);
    assertEquals(
      manifest.boundaries.find((b) => b.eventId === f.join.event_id)?.resident,
      input.resident,
    );
    await roundTrip(f, manifest);
  } finally {
    await f.close();
  }
});

Deno.test('whole-room suffix keeps the opening resident when a later ACL admits a different relayer', async () => {
  const f = await fixture({ deny: ['later.test'] });
  const dir = await Deno.makeTempDir({ prefix: 'replica-opening-resident-' });
  const destination = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const initial = await exportReplicaRoom(room, f.input.self);
    await importReplicaRoom(destination, initial, f.input);
    const deps = {
      keys: f.input.keys,
      fetcher: fakeFetcher({}).fetcher,
      self: f.input.self,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    };
    const allow = await f.source.addEvent({
      type: 'm.room.server_acl',
      state_key: '',
      content: { allow: ['*'], deny: [], allow_ip_literals: true },
    });
    await ingestRemote(room, [allow], f.input.resident, deps);
    const first = await exportReplicaRoom(room, f.input.self, initial.cut);
    await importReplicaRoom(destination, first, f.input);
    const message = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'valid new relayer', msgtype: 'm.text' },
    });
    const result = await ingestRemote(room, [message], 'later.test', deps);
    assertEquals(result[0].outcome, 'accepted');
    const second = await exportReplicaRoom(room, f.input.self, first.cut);
    await importReplicaRoom(destination, second, f.input);
    const replica = await openRoom(destination, room.id);
    assertEquals(
      (await replica.tx((tx) => tx.events.getStatus(String(message.event_id))))
        ?.grounding,
      'grounded',
    );
    const head = await replica.tx((tx) => tx.changes.head());
    await importReplicaRoom(destination, second, f.input);
    assertEquals(await replica.tx((tx) => tx.changes.head()), head);
  } finally {
    await destination.close();
    await Deno.remove(dir, { recursive: true });
    await f.close();
  }
});

Deno.test('whole-room suffix promotes retained pending evidence exactly once after a cold reopen', async () => {
  const f = await fixture();
  const dir = await Deno.makeTempDir({
    prefix: 'replica-evidence-transition-',
  });
  const config = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let destination = await openStore(config, { schemas: { room: roomSchema } });
  try {
    await importReplicaBoundary(f.store, f.input);
    const room = await openRoom(f.store, f.source.roomId);
    const deps = {
      keys: f.input.keys,
      fetcher: fakeFetcher({}).fetcher,
      self: f.input.self,
      limits: { waitMs: 0, limit: 100, budgetMs: 1000 },
      ungroundedMs: 3600000,
    };
    const parent = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'arrives later', msgtype: 'm.text' },
    });
    const child = await f.source.addEvent({
      type: 'm.room.message',
      content: { body: 'pending first writer', msgtype: 'm.text' },
    });
    const childId = String(child.event_id);
    assertEquals(
      (await ingestRemote(room, [child], f.input.resident, deps))[0].outcome,
      'pending',
    );
    const bootstrap = await exportReplicaRoom(room, f.input.self);
    await importReplicaRoom(destination, bootstrap, f.input);
    let replica = await openRoom(destination, room.id);
    const bytes = await replica.tx(async (tx) => {
      assertEquals((await tx.events.getStatus(childId))?.grounding, 'evidence');
      assertEquals(await tx.segments.positionOf(childId), null);
      const head = await tx.changes.head();
      for (const promoteEvidence of [false, true]) {
        const result = await ingestInTx(tx, room.id, child, {
          remote: {
            origin: f.input.resident,
            self: f.input.self,
            oversized: false,
            ungroundedMs: 0,
            promoteEvidence,
          },
        });
        assertEquals(result.grounding, 'evidence');
        assertEquals(result.stored, true);
      }
      assertEquals(await tx.changes.head(), head);
      return (await tx.events.get(childId))!.pdu;
    });
    await destination.close();
    destination = await openStore(config, { schemas: { room: roomSchema } });
    await ingestRemote(room, [parent], f.input.resident, deps);
    assertEquals(
      (await room.tx((tx) => tx.events.getStatus(childId)))?.grounding,
      'grounded',
    );
    const suffix = await exportReplicaRoom(room, f.input.self, bootstrap.cut);
    await importReplicaRoom(destination, suffix, f.input);
    replica = await openRoom(destination, room.id);
    const read = () =>
      replica.tx(async (tx) => {
        assertEquals(
          (await tx.events.getStatus(childId))?.standing,
          'accepted',
        );
        assertEquals(
          (await tx.events.getStatus(childId))?.grounding,
          'grounded',
        );
        assertEquals((await tx.events.get(childId))!.pdu, bytes);
        assert(await tx.state.eventStateAfter(childId));
        assert(await tx.segments.positionOf(childId));
        const changes = await tx.changes.after(0, await tx.changes.head());
        const transitions = changes.filter((entry) =>
          entry.event === childId && entry.kind === 'transition'
        );
        assertEquals(transitions.length, 1);
        assertEquals(JSON.parse(transitions[0].data).from, {
          standing: 'accepted',
          grounding: 'evidence',
        });
        return await tx.changes.head();
      });
    const head = await read();
    await importReplicaRoom(destination, suffix, f.input);
    assertEquals(await read(), head);
  } finally {
    await destination.close();
    await Deno.remove(dir, { recursive: true });
    await f.close();
  }
});
