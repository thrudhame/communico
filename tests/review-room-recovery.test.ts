// Recovery is over verified batch dependencies; auth recovery is independent
// of prev recovery, and a network failure cannot abort unrelated PDUs.
import { assert, assertEquals } from '@std/assert';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { backfill } from '#engine/room/history.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { joinRemote } from '#engine/room/join.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { fakeFetcher, fakeKeyResolver } from './fixtures/remote.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';

async function withStore(fn: (store: Store) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function setup(store: Store, name: string) {
  const fr = await makeFakeRoom({ roomId: '!' + name + ':remote.test' });
  const keys = fakeKeyResolver(fr.server, await testRemoteServer());
  const initial = fakeFetcher({
    makeJoin: (user) => fr.makeJoinAnswer(user),
    sendJoin: (event) => fr.acceptSendJoin(event),
  });
  await joinRemote(store, {
    roomId: fr.roomId,
    user: '@anna:test',
    via: [fr.server.name],
    signer: await testSigner(),
    deps: { keys, self: 'test', fetcher: initial.fetcher },
  });
  return { fr, keys, room: await openRoom(store, fr.roomId), base: fr.tipId };
}

for (const batch of [false, true]) {
  Deno.test(`review recovery: grounded prevs still recover declared auth (batch=${batch})`, async () => {
    await withStore(async (store) => {
      const { fr, keys, room, base } = await setup(store, 'auth-only-' + batch);
      const pl = await fr.addEvent({
        type: 'm.room.power_levels',
        state_key: '',
        content: { users: { [fr.creator]: 100 }, events_default: 0 },
      });
      const probe = {
        type: 'm.room.message',
        sender: fr.creator,
        content: { body: 'with new auth' },
      } as unknown as Pdu;
      const auth = getRulebook(fr.version).selectAuthEvents(
        probe,
        fr.afterOf.get(pl.event_id!)!,
      );
      const parent = await fr.addEvent({
        ...probe,
        prev_events: [base],
        auth_events: auth,
      });
      const child = await fr.addEvent({
        type: 'm.room.message',
        content: { body: 'child' },
      });
      const scripted = fakeFetcher({
        eventAuth: new Map([[parent.event_id!, [...fr.events.values()]]]),
      });
      const result = await ingestRemote(
        room,
        batch ? [child, parent] : [parent],
        fr.server.name,
        {
          keys,
          self: 'test',
          fetcher: scripted.fetcher,
          limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
          ungroundedMs: 0,
        },
      );
      assertEquals(
        result.map((item) => item.outcome),
        batch ? ['accepted', 'accepted'] : ['accepted'],
      );
      assertEquals(scripted.calls.missingEvents, []);
      assertEquals(scripted.calls.stateIds, []);
      assertEquals(scripted.calls.eventAuth, [parent.event_id!]);
      assertEquals(
        (await room.tx((tx) => tx.events.getStatus(pl.event_id!)))?.standing,
        'accepted',
      );
    });
  });
}

Deno.test('review recovery: pulled batches expose their actual gap without refetching supplied bytes', async () => {
  await withStore(async (store) => {
    const { fr, keys, room } = await setup(store, 'batch-gap');
    const gap = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'gap' },
    });
    const parent = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'parent' },
    });
    const child = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'child' },
    });
    const scripted = fakeFetcher({
      stateIds: new Map([[gap.event_id!, fr.stateIdsAt(gap.event_id!)!]]),
      event: fr.events,
    });
    const result = await ingestRemote(room, [child, parent], fr.server.name, {
      keys,
      self: 'test',
      fetcher: scripted.fetcher,
      limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
      ungroundedMs: 0,
    }, 'pulled');
    assertEquals(result.map((item) => item.outcome), ['accepted', 'accepted']);
    assertEquals(scripted.calls.stateIds, [gap.event_id!]);
    assertEquals(scripted.calls.missingEvents.length, 1);
    assert(!scripted.calls.event.includes(parent.event_id!));
    assert(!scripted.calls.event.includes(child.event_id!));
  });
});

for (const route of ['remote', 'history'] as const) {
  for (const failure of ['stateIds', 'event'] as const) {
    Deno.test(`review recovery: ${route} ${failure} failure preserves independent outcomes`, async () => {
      await withStore(async (store) => {
        const { fr, keys, room, base } = await setup(
          store,
          'fetch-failure-' + route + failure,
        );
        const unknown = await fr.addEvent({
          type: 'm.room.topic',
          state_key: '',
          content: { topic: 'unknown auth' },
        });
        const gap = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'gap' },
        });
        const child = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'child' },
        });
        const good = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'good' },
          prev_events: [base],
        });
        const fail = () =>
          Promise.reject(
            new UpstreamError('transport', {
              phase: 'read',
              reason: 'network unavailable',
            }),
          );
        const scripted = fakeFetcher({
          stateIds: new Map([[gap.event_id!, fr.stateIdsAt(gap.event_id!)!]]),
          event: fr.events,
          backfill: [good, gap],
          ...(failure === 'stateIds'
            ? { onStateIds: fail }
            : { onEvent: fail }),
        });
        if (route === 'remote') {
          const result = await ingestRemote(
            room,
            [child, good],
            fr.server.name,
            {
              keys,
              self: 'test',
              fetcher: scripted.fetcher,
              limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
              ungroundedMs: 0,
            },
          );
          assertEquals(result[1].outcome, 'accepted');
          assertEquals(result[0].outcome, 'dropped');
        } else {
          const result = await backfill(room, {
            from: [gap.event_id!, good.event_id!],
            via: fr.server.name,
            limit: 100,
          }, { self: 'test', keys, fetcher: scripted.fetcher });
          assertEquals(result.positioned, [good.event_id!]);
          assertEquals(
            await room.tx((tx) => tx.state.eventStateAfter(gap.event_id!)),
            null,
          );
        }
        assertEquals(
          await room.tx((tx) => tx.events.get(unknown.event_id!)),
          null,
        );
      });
    });
  }
}

Deno.test('review recovery: one malformed answer cannot tombstone a valid supplied parent', async () => {
  await withStore(async (store) => {
    const { fr, keys, room } = await setup(store, 'mixed-answer');
    const gap = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'gap' },
    });
    const parent = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'parent' },
    });
    const child = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'child' },
    });
    const scripted = fakeFetcher({
      missingEvents: [parent, {} as Pdu],
      stateIds: new Map([[gap.event_id!, fr.stateIdsAt(gap.event_id!)!]]),
      event: fr.events,
    });
    const result = await ingestRemote(room, [child], fr.server.name, {
      keys,
      self: 'test',
      fetcher: scripted.fetcher,
      limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
      ungroundedMs: 0,
    });
    assertEquals(result[0].outcome, 'accepted');
    assertEquals(scripted.calls.stateIds, [gap.event_id!]);
  });
});

Deno.test('review recovery: event_auth failure does not prevent a grounded sibling from landing', async () => {
  await withStore(async (store) => {
    const { fr, keys, room, base } = await setup(store, 'auth-failure');
    const pl = await fr.addEvent({
      type: 'm.room.power_levels',
      state_key: '',
      content: { users: { [fr.creator]: 100 } },
    });
    const orphan = await fr.addEvent({
      type: 'm.room.message',
      content: { body: 'orphan' },
    });
    const good = await fr.addEvent({
      type: 'm.room.message',
      prev_events: [base],
      content: { body: 'good' },
    });
    const scripted = fakeFetcher({
      onEventAuth: () =>
        Promise.reject(
          new UpstreamError('transport', {
            phase: 'read',
            reason: 'unreachable',
          }),
        ),
    });
    const result = await ingestRemote(room, [orphan, good], fr.server.name, {
      keys,
      self: 'test',
      fetcher: scripted.fetcher,
      limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
      ungroundedMs: 0,
    });
    assertEquals(result.map((item) => item.outcome), ['dropped', 'accepted']);
    assertEquals(scripted.calls.eventAuth, [orphan.event_id!]);
    assertEquals(await room.tx((tx) => tx.events.get(pl.event_id!)), null);
  });
});
