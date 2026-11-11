import { assert, assertEquals, assertNotEquals } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { fetchBoundaryEvents } from '#engine/room/boundary-fetch.ts';
import { backfill } from '#engine/room/history.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { joinRemote } from '#engine/room/join.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { openStore } from '#engine/store/index.ts';
import { makeFakeRoom } from './fixtures/remote-room.ts';
import { fakeFetcher, fakeKeyResolver, wireOf } from './fixtures/remote.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';

for (const route of ['remote', 'history'] as const) {
  for (
    const mode of [
      'complete',
      'partial',
      'unavailable',
      'invalid',
      'foreign',
      'duplicates',
      'scan-overflow',
      ...(route === 'history'
        ? ['work-budget', 'request-budget'] as const
        : []),
    ] as const
  ) {
    Deno.test(`boundary fetch: ${route} dense state (${mode})`, async () => {
      const dir = await Deno.makeTempDir();
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { room: roomSchema } });
      try {
        const fr = await makeFakeRoom({
          roomId: '!bulk-' + route + ':remote.test',
        });
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
        const room = await openRoom(store, fr.roomId);
        const state: Pdu[] = [];
        const tight = mode === 'work-budget' || mode === 'request-budget';
        for (let i = 0; i < (tight ? 1 : 24); i++) {
          state.push(
            await fr.addEvent({
              type: 'org.communico.state',
              state_key: String(i),
              content: { i },
            }),
          );
        }
        const gap = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'gap' },
        });
        const child = await fr.addEvent({
          type: 'm.room.message',
          content: { body: 'child' },
        });
        const ids = fr.stateIdsAt(gap.event_id!)!;
        const invalid = mode === 'invalid' || mode === 'foreign';
        if (mode === 'invalid') state[0].signatures = {};
        if (mode === 'foreign') state[0].room_id = '!another:remote.test';
        const scripted = fakeFetcher({
          stateIds: new Map([[gap.event_id!, ids]]),
          event: fr.events,
          backfill: [gap],
        });
        let bulkCalls = 0;
        const fetcher = Object.assign(scripted.fetcher, {
          state: (roomId: string, at: string, via: string) => {
            assertEquals([roomId, at, via], [
              fr.roomId,
              gap.event_id,
              fr.server.name,
            ]);
            bulkCalls++;
            if (mode === 'unavailable') return Promise.resolve(null);
            const returned = ids.pduIds.filter((id) =>
              mode !== 'partial' || id !== state[0].event_id
            );
            return Promise.resolve({
              state: [...returned, ...(mode === 'duplicates' ? returned : [])]
                .map((id) => wireOf(fr.events.get(id)!)),
              authChain: mode === 'scan-overflow'
                ? Array.from(
                  { length: 100 },
                  () => wireOf(fr.events.get(fr.createId)!),
                )
                : ids.authChainIds.filter((id) =>
                  mode !== 'partial' || id !== state[0].event_id
                ).map((id) => wireOf(fr.events.get(id)!)),
            });
          },
        });
        if (route === 'remote') {
          const result = await ingestRemote(room, [child], fr.server.name, {
            keys,
            self: 'test',
            fetcher,
            limits: { waitMs: 0, budgetMs: 8000, limit: 100 },
            ungroundedMs: 0,
          });
          if (invalid) assertNotEquals(result[0].outcome, 'accepted');
          else assertEquals(result[0].outcome, 'accepted');
        } else {
          const budget = tight
            ? {
              signal: AbortSignal.timeout(8000),
              requests: mode === 'request-budget' ? 3 : 128,
              work: new Set([...ids.pduIds, ...ids.authChainIds]).size + 4,
              exhausted: false,
            }
            : undefined;
          const result = await backfill(room, {
            from: [gap.event_id!],
            via: fr.server.name,
            limit: 100,
          }, { keys, fetcher, budget });
          assertEquals(result.positioned.includes(gap.event_id!), !invalid);
        }
        assertEquals(bulkCalls, mode === 'request-budget' ? 0 : 1);
        const fetched = scripted.calls.event.filter((id) =>
          state.some((p) => p.event_id === id)
        );
        assertEquals(
          fetched.length,
          mode === 'request-budget'
            ? 1
            : mode === 'unavailable' || mode === 'scan-overflow'
            ? 24
            : mode === 'complete' || mode === 'duplicates' ||
                mode === 'work-budget'
            ? 0
            : 1,
        );
        await room.tx(async (tx) => {
          const before = await tx.state.eventStateBefore(gap.event_id!);
          if (invalid) {
            assertEquals(before, null);
            assertEquals(await tx.events.get(state[0].event_id!), null);
            return;
          }
          assert(before !== null);
          const map = await tx.state.groupMap(before.group);
          for (const pdu of state) {
            assertEquals(
              map.get(pdu.type + '\0' + pdu.state_key),
              pdu.event_id,
            );
            assertEquals(
              (await tx.events.getStatus(pdu.event_id!))?.standing,
              'accepted',
            );
          }
        });
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
}

Deno.test('boundary fetch: sparse recovery excludes bulk and unrelated snapshot events', async () => {
  const fr = await makeFakeRoom({ roomId: '!sparse:remote.test' });
  const pdu = await fr.addEvent({
    type: 'm.room.message',
    content: { body: 'wanted' },
  });
  const scripted = fakeFetcher({ event: fr.events });
  const pack = await fetchBoundaryEvents([pdu.event_id!], 100, {
    roomId: fr.roomId,
    at: pdu.event_id!,
    via: fr.server.name,
    version: fr.version,
    fetcher: scripted.fetcher,
    keys: fakeKeyResolver(fr.server),
    concurrency: 8,
    active: () => true,
    read: (op) => op(),
  });
  assertEquals([...pack!.keys()], [pdu.event_id!]);
  assertEquals(scripted.calls.state, []);
  assertEquals(scripted.calls.event, [pdu.event_id!]);

  const other = await fr.addEvent({
    type: 'm.room.message',
    content: { body: 'unrequested' },
  });
  let verifications = 0;
  const keys = fakeKeyResolver(fr.server);
  const dense = await fetchBoundaryEvents([pdu.event_id!], 1, {
    roomId: fr.roomId,
    at: pdu.event_id!,
    via: fr.server.name,
    version: fr.version,
    fetcher: Object.assign(scripted.fetcher, {
      state: () =>
        Promise.resolve({
          state: [wireOf(other), wireOf(pdu), wireOf(pdu)],
          authChain: [],
        }),
    }),
    keys: {
      verifyEventSignature: (args) => {
        verifications++;
        return keys.verifyEventSignature(args);
      },
    },
    concurrency: 8,
    active: () => true,
    read: (op) => op(),
  });
  assertEquals([...dense!.keys()], [pdu.event_id!]);
  assertEquals(
    verifications,
    1,
    'only the missing requested event crosses signature verification once',
  );
});

Deno.test('boundary fetch: only missing unique candidates spend admission work', async () => {
  const fr = await makeFakeRoom({ roomId: '!work:remote.test' });
  const first = await fr.addEvent({
    type: 'org.communico.state',
    state_key: 'a',
    content: {},
  });
  const second = await fr.addEvent({
    type: 'org.communico.state',
    state_key: 'b',
    content: {},
  });
  const other = await fr.addEvent({ type: 'm.room.message', content: {} });
  const scripted = fakeFetcher({ event: fr.events });
  let work = 2;
  let exhausted = false;
  const pack = await fetchBoundaryEvents(
    [first.event_id!, second.event_id!],
    3,
    {
      roomId: fr.roomId,
      at: other.event_id!,
      via: fr.server.name,
      version: fr.version,
      fetcher: Object.assign(scripted.fetcher, {
        state: () =>
          Promise.resolve({
            authChain: [
              wireOf(fr.events.get(fr.createId)!),
              wireOf(first),
              wireOf(first),
            ],
            state: [wireOf(other), wireOf(second)],
          }),
      }),
      keys: fakeKeyResolver(fr.server),
      concurrency: 1,
      active: () => !exhausted,
      work: () => {
        if (work === 0) {
          exhausted = true;
          return false;
        }
        work--;
        return true;
      },
      read: (op) => op(),
    },
  );
  assertEquals([...pack!.keys()], [first.event_id!, second.event_id!]);
  assertEquals(work, 0);
  assertEquals(exhausted, false);
  assertEquals(scripted.calls.event, []);
});
