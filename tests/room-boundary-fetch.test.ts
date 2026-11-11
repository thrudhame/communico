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
        for (let i = 0; i < 24; i++) {
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
              authChain: ids.authChainIds.filter((id) =>
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
          const result = await backfill(room, {
            from: [gap.event_id!],
            via: fr.server.name,
            limit: 100,
          }, { keys, fetcher });
          assertEquals(result.positioned.includes(gap.event_id!), !invalid);
        }
        assertEquals(bulkCalls, 1);
        const fetched = scripted.calls.event.filter((id) =>
          state.some((p) => p.event_id === id)
        );
        assertEquals(
          fetched.length,
          mode === 'unavailable'
            ? 24
            : mode === 'complete' || mode === 'duplicates'
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
