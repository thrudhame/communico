// Consumer regressions for immutable room identity and join provenance.
import { assert, assertEquals, assertRejects } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { buildCreate } from '#engine/room/build.ts';
import { createRoom } from '#engine/room/create.ts';
import { backfill } from '#engine/room/history.ts';
import { ingestLocal } from '#engine/room/ingest.ts';
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

Deno.test('review identity: a second create cannot replace state; original redelivery keeps its receipt', async () => {
  await withStore(async (store) => {
    for (const version of ['3', '6', '10', '11']) {
      const signer = await testSigner();
      const creator = '@dev:test';
      const created = await createRoom(store, { creator, version }, signer);
      const g = {
        room: await openRoom(store, created.roomId),
        roomId: created.roomId,
        createId: created.createEventId,
        signer,
        creator,
      };
      const before = await g.room.tx(async (tx) => {
        const stay = (await tx.segments.openStay())!;
        return {
          group: await tx.state.current(stay.id),
          frontier: await tx.extremities.frontier(stay.id),
          changes: (await tx.changes.after(0, 1000)).length,
          original: await tx.events.get(g.createId),
        };
      });
      const replacement = await buildCreate(
        {
          roomId: g.roomId,
          sender: g.creator,
          content: { creator: g.creator, room_version: version },
          origin_server_ts: 9999,
        },
        g.signer,
        version,
      );
      const result = await ingestLocal(g.room, replacement, signer.serverName);
      assertEquals(result.standing, 'rejected');
      assertEquals(result.receipt, false);
      await g.room.tx(async (tx) => {
        const stay = (await tx.segments.openStay())!;
        assertEquals(await tx.state.current(stay.id), before.group);
        assertEquals(await tx.extremities.frontier(stay.id), before.frontier);
        assertEquals(await tx.segments.positionOf(result.eventId), null);
        assertEquals(await tx.events.get(g.createId), before.original);
      });
      const original = JSON.parse(before.original!.pdu) as Pdu;
      const receipt = await ingestLocal(g.room, original, signer.serverName);
      assertEquals(receipt.receipt, true);
      assertEquals(receipt.standing, 'accepted');
      // Only the rejected replacement adds an event change, never a publication.
      await g.room.tx(async (tx) => {
        const newChanges = (await tx.changes.after(0, 1000)).slice(
          before.changes,
        );
        assertEquals(newChanges.map((change) => change.kind), ['event']);
      });
      const foreignVersion = await buildCreate(
        {
          roomId: g.roomId,
          sender: g.creator,
          content: { creator: g.creator, room_version: '99' },
          origin_server_ts: 10000,
        },
        signer,
        version,
      );
      assertEquals(
        (await ingestLocal(g.room, foreignVersion, signer.serverName)).standing,
        'rejected',
      );
    }
  });
});

for (
  const route of [
    'remote-evidence',
    'history-evidence',
    'history-page',
  ] as const
) {
  Deno.test(`review identity: ${route} cannot introduce another create`, async () => {
    await withStore(async (store) => {
      const fr = await makeFakeRoom({
        roomId: '!different-root-' + route + ':remote.test',
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
        deps: { keys, fetcher: initial.fetcher, self: 'test' },
      });
      const room = await openRoom(store, fr.roomId);
      const alternative = await makeFakeRoom({
        roomId: fr.roomId,
        server: fr.server,
        creator: '@mallory:remote.test',
      });
      const tip = await alternative.addEvent({
        type: 'm.room.message',
        content: { body: 'other root' },
      });
      const child = await alternative.addEvent({
        type: 'm.room.message',
        content: { body: 'child' },
      });
      const scripted = fakeFetcher({
        stateIds: new Map([[
          tip.event_id!,
          alternative.stateIdsAt(tip.event_id!)!,
        ]]),
        event: alternative.events,
        backfill: route === 'history-page'
          ? [alternative.events.get(alternative.createId)!]
          : [tip],
      });
      if (route === 'remote-evidence') {
        // Pulled recovery still must reject a foreign room root.
        const result = await ingestRemote(room, [child], fr.server.name, {
          keys,
          fetcher: scripted.fetcher,
          self: 'test',
          limits: { waitMs: 0, budgetMs: 10000, limit: 100 },
          ungroundedMs: 0,
        }, 'pulled');
        assertEquals(result[0].outcome, 'dropped');
      } else {
        const result = await backfill(room, {
          from: [
            route === 'history-page' ? alternative.createId : tip.event_id!,
          ],
          via: fr.server.name,
          limit: 100,
        }, { keys, fetcher: scripted.fetcher });
        assertEquals(result.positioned, []);
      }
      await room.tx(async (tx) => {
        assertEquals(
          (await tx.events.getStatus(alternative.createId))?.standing,
          'rejected',
        );
        assertEquals(await tx.segments.positionOf(alternative.createId), null);
        assertEquals(await tx.state.eventStateAfter(tip.event_id!), null);
        const stay = (await tx.segments.openStay())!;
        const group = (await tx.state.current(stay.id))!;
        assertEquals(
          await tx.state.groupKey(group, 'm.room.create', ''),
          fr.createId,
        );
      });
    });
  });
}

Deno.test('review identity: a resident cannot vouch for a third-party snapshot sender', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({
      roomId: '!thirdparty:other.test',
      creator: '@zoe:other.test',
    });
    const { fetcher } = fakeFetcher({
      makeJoin: (user) => fr.makeJoinAnswer(user),
      sendJoin: (event) => fr.acceptSendJoin(event),
    });
    const signer = await testSigner();
    await assertRejects(() =>
      joinRemote(store, {
        roomId: fr.roomId,
        user: '@anna:test',
        via: [fr.server.name],
        signer,
        deps: { keys: fakeKeyResolver(fr.server), fetcher, self: 'test' },
      })
    );
    await assertRejects(() => openRoom(store, fr.roomId));
  });
});

Deno.test('review identity: own snapshot fallback retains hash normalization', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!ownfallback:remote.test' });
    const prior = await fr.addEvent({
      type: 'm.room.member',
      sender: '@prior:test',
      state_key: '@prior:test',
      content: { membership: 'join', displayname: 'signed profile' },
    });
    const { fetcher } = fakeFetcher({
      makeJoin: (user) => fr.makeJoinAnswer(user),
      sendJoin: (event) =>
        fr.acceptSendJoin(event, (response) => {
          for (const pdu of [...response.state, ...response.authChain]) {
            if (pdu.event_id !== prior.event_id) continue;
            pdu.content = {
              membership: 'join',
              displayname: 'tampered profile',
            };
            pdu.unsigned = { injected: true };
          }
        }),
    });
    await joinRemote(store, {
      roomId: fr.roomId,
      user: '@anna:test',
      via: [fr.server.name],
      signer: await testSigner(),
      deps: { keys: fakeKeyResolver(fr.server), fetcher, self: 'test' },
    });
    const room = await openRoom(store, fr.roomId);
    await room.tx(async (tx) => {
      const row = await tx.events.get(String(prior.event_id));
      assert(row !== null);
      const stored = JSON.parse(row.pdu) as Pdu;
      assertEquals(stored.content, { membership: 'join' });
      assertEquals(stored.unsigned, undefined);
    });
  });
});

Deno.test('review identity: returned join contributes only its verified resident signature', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!returnedjoin:remote.test' });
    const { fetcher } = fakeFetcher({
      makeJoin: (user) => fr.makeJoinAnswer(user),
      sendJoin: (event) =>
        fr.acceptSendJoin(event, (response) => {
          response.event.content = {
            membership: 'join',
            displayname: 'resident rewrite',
          };
          response.event.signatures![fr.server.name]['ed25519:forged'] =
            'forged';
          response.event.signatures!['injected.test'] = {
            'ed25519:1': 'forged',
          };
        }),
    });
    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: '@anna:test',
      via: [fr.server.name],
      signer: await testSigner(),
      content: { displayname: 'authored profile', reason: 'authored reason' },
      deps: { keys: fakeKeyResolver(fr.server), fetcher, self: 'test' },
    });
    const room = await openRoom(store, fr.roomId);
    await room.tx(async (tx) => {
      const stored = JSON.parse(
        (await tx.events.get(result.eventId))!.pdu,
      ) as Pdu;
      assertEquals(stored.content, {
        membership: 'join',
        displayname: 'authored profile',
        reason: 'authored reason',
      });
      assertEquals(
        Object.keys(stored.signatures!).sort(),
        [fr.server.name, 'test'].sort(),
      );
      assertEquals(Object.keys(stored.signatures![fr.server.name]), [
        fr.server.keyId,
      ]);
    });
  });
});
