import { assert, assertEquals } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { loadRulebookStore } from '#engine/room/build.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { openStore } from '#engine/store/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';
import { testSigner } from './fixtures/signer.ts';

async function withRecovery(
  limit: number,
  fn: (s: Awaited<ReturnType<typeof setup>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { room: roomSchema } });
  try {
    await fn(await setup(store, limit));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function setup(
  store: Awaited<ReturnType<typeof openStore>>,
  limit: number,
) {
  const signer = await testSigner();
  const creator = '@dev:' + signer.serverName;
  const created = await createRoom(store, {
    creator,
    version: '12',
    preset: 'public_chat',
  }, signer);
  const room = await openRoom(store, created.roomId);
  const server = await makeRemoteServer('remote.test');
  const user = '@eve:remote.test';
  const current = () =>
    room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      return await tx.state.groupMap((await tx.state.current(stay!.id))!);
    });
  const initial = await current();
  const pl1 = initial.get('m.room.power_levels\0')!;
  const joinRules = initial.get('m.room.join_rules\0')!;
  const frontier = await room.tx(async (tx) =>
    await tx.extremities.frontier((await tx.segments.openStay())!.id)
  );
  const member = async (prev: string[], auth: string[], index: number) =>
    await remoteEvent(room.id, server, '12', {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join', displayname: 'Eve ' + index },
      prev_events: prev,
      auth_events: auth,
      depth: 20 + index,
      origin_server_ts: 200 + index,
    });
  const join = await member(frontier, [pl1, joinRules], 0);
  const deps = {
    self: signer.serverName,
    keys: fakeKeyResolver(server),
    fetcher: fakeFetcher({}).fetcher,
    limits: { waitMs: 0, limit, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
  };
  assertEquals(
    (await ingestRemote(room, [join], server.name, deps))[0].outcome,
    'accepted',
  );
  const pl2 = await sendLocal(room, {
    type: 'm.room.power_levels',
    state_key: '',
    sender: creator,
    content: { users: { [user]: 50 } },
    origin_server_ts: 300,
  }, signer);
  assertEquals(pl2.standing, 'accepted');
  const pl3 = await remoteEvent(room.id, server, '12', {
    type: 'm.room.power_levels',
    state_key: '',
    sender: user,
    content: { users: { [user]: 50, '@charlie:remote.test': 50 } },
    prev_events: [pl2.eventId],
    auth_events: [pl2.eventId, join.event_id!],
    depth: 22,
    origin_server_ts: 301,
  });
  assertEquals(
    (await ingestRemote(room, [pl3], server.name, deps))[0].outcome,
    'accepted',
  );
  const chain: Pdu[] = [];
  let prev = pl3.event_id!;
  let auth = join.event_id!;
  for (let i = 0; i < 25; i++) {
    const event = await member(
      [prev],
      [pl3.event_id!, auth, joinRules],
      i + 10,
    );
    chain.push(event);
    prev = auth = event.event_id!;
  }
  const boundary = await current();
  boundary.set('m.room.power_levels\0', pl1);
  boundary.set('m.room.member\0' + user, chain[13].event_id!);
  return {
    room,
    server,
    deps,
    current,
    created,
    join,
    pl3,
    chain,
    boundary,
    signer,
    creator,
  };
}

Deno.test('recovery: v12 auth stores include the implicit room create', async () => {
  await withRecovery(10, async (s) => {
    await s.room.tx(async (tx) => {
      // v12 deliberately excludes create from auth_events, but rule 2
      // still needs the accepted room root when checking this valid event.
      const store = await loadRulebookStore(tx, s.join.auth_events!);
      assertEquals(getRulebook('12').checkAuthChain(s.join, store).ok, true);
      assertEquals(store.get(s.created.createEventId)?.type, 'm.room.create');
    });
  });
});

Deno.test('recovery: a v12 imported fork retains its full evidence and conflicted subgraph', async (t) => {
  for (const limit of [10, 300]) {
    await t.step('missing-event limit ' + limit, async () => {
      await withRecovery(limit, async (s) => {
        const at = s.chain[14];
        const evidence = s.chain.slice(0, 14);
        let active = 0;
        let peak = 0;
        const recording = fakeFetcher({
          missingEvents: s.chain.slice(15, 24),
          stateIds: new Map([[at.event_id!, {
            pduIds: [...s.boundary.values()].reverse(),
            authChainIds: evidence.slice(0, 13).map((p) => p.event_id!)
              .reverse(),
          }]]),
          event: new Map(s.chain.map((p) => [p.event_id!, p])),
          onEvent: async () => {
            peak = Math.max(peak, ++active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
          },
        });
        s.deps.fetcher = recording.fetcher;
        const out = await ingestRemote(
          s.room,
          [s.chain[24]],
          s.server.name,
          s.deps,
        );
        assertEquals(out[0].outcome, 'accepted');
        assert(peak > 1 && peak <= 8, 'bounded parallel evidence reads');
        assertEquals(active, 0, 'all evidence reads settle before ingest');
        assertEquals(recording.calls.missingEvents[0].limit, limit);
        await s.room.tx(async (tx) => {
          for (const pdu of evidence) {
            const status = await tx.events.getStatus(pdu.event_id!);
            assertEquals(status?.standing, 'accepted');
            assertEquals(status?.grounding, 'evidence');
            assertEquals(await tx.state.eventStateAfter(pdu.event_id!), null);
            assertEquals(await tx.segments.positionOf(pdu.event_id!), null);
          }
          const before = await tx.state.eventStateBefore(at.event_id!);
          assert(before !== null);
          assertEquals(before.provenance, 'imported');
          assertEquals(await tx.state.groupMap(before.group), s.boundary);
          assert(
            (await tx.segments.positionOf(s.chain[24].event_id!)) !== null,
          );
        });
        // The stale imported PL1 must not erase PL3. V2.1 includes PL2
        // between the conflicted PL3/PL1 and reauthorizes the whole chain.
        assertEquals(
          (await s.current()).get('m.room.power_levels\0'),
          s.pl3.event_id,
        );
      });
    });
  }
});

Deno.test('recovery: an unavailable state event cannot become a partial imported boundary', async () => {
  await withRecovery(10, async (s) => {
    const at = s.chain[14];
    const recording = fakeFetcher({
      missingEvents: s.chain.slice(15, 24),
      stateIds: new Map([[at.event_id!, {
        pduIds: [...s.boundary.values()],
        authChainIds: [],
      }]]),
      event: new Map([[at.event_id!, at]]),
    });
    s.deps.fetcher = recording.fetcher;
    const out = await ingestRemote(
      s.room,
      [s.chain[24]],
      s.server.name,
      s.deps,
    );
    assertEquals(out[0].outcome, 'pending');
    await s.room.tx(async (tx) => {
      assertEquals(await tx.state.eventStateBefore(at.event_id!), null);
      assertEquals(await tx.segments.positionOf(s.chain[24].event_id!), null);
    });
    assertEquals(
      (await s.current()).get('m.room.power_levels\0'),
      s.pl3.event_id,
    );
  });
});

Deno.test('recovery: event_auth evidence is not truncated to the missing-event batch size', async () => {
  await withRecovery(10, async (s) => {
    const pushed = await remoteEvent(s.room.id, s.server, '12', {
      type: 'm.room.message',
      sender: s.join.sender,
      content: { body: 'still waiting for its prev' },
      prev_events: ['$unavailable-prev'],
      auth_events: [s.chain[24].event_id!],
      depth: 100,
    });
    s.deps.fetcher = fakeFetcher({
      eventAuth: new Map([[pushed.event_id!, [...s.chain].reverse()]]),
    }).fetcher;
    const out = await ingestRemote(s.room, [pushed], s.server.name, s.deps);
    assertEquals(out[0].outcome, 'pending');
    await s.room.tx(async (tx) => {
      for (const pdu of s.chain) {
        assertEquals(
          (await tx.events.getStatus(pdu.event_id!))?.standing,
          'accepted',
        );
        assertEquals(await tx.state.eventStateAfter(pdu.event_id!), null);
      }
    });
  });
});

Deno.test('recovery: an auth response arriving after the budget cannot expose a partial pack', async () => {
  await withRecovery(10, async (s) => {
    const pushed = await remoteEvent(s.room.id, s.server, '12', {
      type: 'm.room.message',
      sender: s.join.sender,
      content: {},
      prev_events: ['$unavailable-prev'],
      auth_events: [s.chain[24].event_id!],
      depth: 100,
    });
    s.deps.limits.budgetMs = 1000;
    const recording = fakeFetcher({
      eventAuth: new Map([[pushed.event_id!, s.chain]]),
      onEventAuth: () => new Promise((resolve) => setTimeout(resolve, 1100)),
    });
    s.deps.fetcher = recording.fetcher;
    const out = await ingestRemote(s.room, [pushed], s.server.name, s.deps);
    assertEquals(recording.calls.eventAuth, [pushed.event_id]);
    assertEquals(out[0].outcome, 'pending');
    await s.room.tx(async (tx) => {
      for (const pdu of s.chain) {
        assertEquals(await tx.events.get(pdu.event_id!), null);
      }
    });
  });
});

Deno.test('recovery: large evidence packs yield bounded writes to ordinary room mutations', async (t) => {
  for (const deny of [false, true]) {
    await t.step(
      deny
        ? 'ACL changes invalidate the staged cut'
        : 'ordinary writes interleave',
      () =>
        withRecovery(10, async (s) => {
          const pack: Pdu[] = [];
          for (let i = 0; i < 160; i++) {
            pack.push(
              await remoteEvent(s.room.id, s.server, '12', {
                type: 'm.room.message',
                sender: s.join.sender,
                content: { body: 'evidence ' + i },
                prev_events: ['$absent'],
                auth_events: [s.join.event_id!, s.pl3.event_id!],
                depth: 100,
              }),
            );
          }
          const pushed = await remoteEvent(s.room.id, s.server, '12', {
            type: 'm.room.message',
            sender: s.join.sender,
            content: {},
            prev_events: ['$absent'],
            auth_events: [pack[159].event_id!],
            depth: 101,
          });
          s.deps.fetcher = fakeFetcher({
            eventAuth: new Map([[pushed.event_id!, pack]]),
          }).fetcher;
          const ids = new Set(pack.map((p) => p.event_id!));
          const original = s.room.tx.bind(s.room);
          let inserted = 0;
          let peak = 0;
          let ordinaryAt = Infinity;
          let ordinary: Promise<unknown> | undefined;
          s.room.tx = (body) =>
            original(async (tx) => {
              let count = 0;
              const insert = tx.events.insert;
              tx.events.insert = async (id, pdu) => {
                if (ids.has(id)) {
                  count++;
                  inserted++;
                  if (ordinary === undefined) {
                    ordinary = sendLocal(s.room, {
                      type: deny ? 'm.room.server_acl' : 'm.room.topic',
                      state_key: '',
                      sender: s.creator,
                      content: deny
                        ? { allow: [], deny: ['*'] }
                        : { topic: 'ordinary writer' },
                    }, s.signer).then(() => {
                      ordinaryAt = inserted;
                    });
                  }
                }
                return await insert(id, pdu);
              };
              const result = await body(tx);
              peak = Math.max(peak, count);
              return result;
            });
          const out = await ingestRemote(
            s.room,
            [pushed],
            s.server.name,
            s.deps,
          );
          await ordinary;
          assertEquals(out[0].outcome, deny ? 'refused' : 'pending');
          assert(peak <= 32, 'evidence transaction must be bounded: ' + peak);
          assert(
            ordinaryAt < pack.length,
            'ordinary mutation waited for the entire pack',
          );
          assertEquals(inserted, deny ? 32 : pack.length);
          for (const pdu of pack) {
            const status = await s.room.tx((tx) =>
              tx.events.getStatus(pdu.event_id!)
            );
            if (deny && status === null) continue;
            assertEquals(status?.grounding, 'evidence');
            assertEquals(status?.standing, 'accepted');
          }
        }),
    );
  }
});
