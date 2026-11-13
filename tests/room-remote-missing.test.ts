// tests/room-remote-missing.test.ts — the missing-prev recovery ladder
// (3c-1): the get_missing_events request shape (earliest = our
// extremities), answers landing live in depth order, pending + waits and
// the resume driver, the /state_ids + /event pack with the imported
// boundary, the chase naming the gap tip BEHIND a held event, the
// terminal format drop (no fallthrough) and the corrupted auth chain.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { type Room, roomSchema } from '#engine/room/index.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import { testRemoteServer } from './fixtures/signer.ts';
import { UpstreamHttpError } from '#engine/net/upstream-error.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function setup(
  store: Store,
  opts: {
    roomId?: string;
    deps?: Partial<RemoteDeps>;
    fetch?: Parameters<typeof fakeFetcher>[0];
  } = {},
) {
  const g = await genesis(store, {
    roomId: opts.roomId ?? '!missing:test',
    joinRule: 'public',
  });
  const server = await makeRemoteServer('remote.test');
  const user = '@rudy:remote.test';
  const { fetcher, calls } = fakeFetcher(opts.fetch ?? {});
  const deps: RemoteDeps = {
    keys: fakeKeyResolver(server),
    fetcher,
    self: g.signer.serverName,
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
    ...opts.deps,
  };
  const join = await remoteEvent(g.roomId, server, '11', {
    type: 'm.room.member',
    sender: user,
    state_key: user,
    content: { membership: 'join' },
    prev_events: [g.tipId],
    auth_events: await authAt(g.room, {
      type: 'm.room.member',
      sender: user,
      state_key: user,
      content: { membership: 'join' },
    }, g.tipId),
    origin_server_ts: 100,
  });
  const joined = await ingestRemote(g.room, [join], server.name, deps);
  assertEquals(joined[0].outcome, 'accepted');
  return { g, server, user, deps, calls, joinId: String(join.event_id) };
}

async function msg(
  s: Setup,
  body: string,
  prevIds: string[],
  depth: number,
): Promise<Pdu> {
  return await remoteEvent(s.g.roomId, s.server, '11', {
    type: 'm.room.message',
    sender: s.user,
    content: { msgtype: 'm.text', body },
    prev_events: prevIds,
    auth_events: await authAt(s.g.room, {
      type: 'm.room.message',
      sender: s.user,
      content: {},
    }, s.joinId),
    depth,
    origin_server_ts: 1000 + depth,
  });
}

async function frontierOf(room: Room): Promise<string[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    return stay === null ? [] : await tx.extremities.frontier(stay.id);
  });
}

for (const source of ['fetch', 'verify']) {
  Deno.test(
    'missing: local ' + source +
      ' faults propagate without publishing pending evidence',
    async () => {
      await withStore(async (store) => {
        const s = await setup(store);
        const parent = await msg(s, 'missing-parent', [s.joinId], 50);
        const pushed = await msg(s, 'pushed', [String(parent.event_id)], 51);
        const fault = new Error('local missing ' + source);
        s.deps.fetcher.missingEvents = () => {
          if (source === 'fetch') throw fault;
          return Promise.resolve([parent]);
        };
        const keys = s.deps.keys;
        s.deps.keys = {
          verifyEventSignature: (args) => {
            if (args.pdu.content.body === 'missing-parent') throw fault;
            return keys.verifyEventSignature(args);
          },
        };
        assertStrictEquals(
          await assertRejects(() =>
            ingestRemote(s.g.room, [pushed], s.server.name, s.deps)
          ),
          fault,
        );
        assertEquals(await frontierOf(s.g.room), [s.joinId]);
        assertEquals(
          await s.g.room.tx((tx) => tx.events.get(String(pushed.event_id))),
          null,
        );
      });
    },
  );
}

Deno.test('missing: complete pushed batches need no recovery, including rejected and redaction parents', async (t) => {
  for (const kind of ['message', 'rejected', 'redaction']) {
    await t.step(kind, async () => {
      await withStore(async (store) => {
        const s = await setup(store);
        const parent = await remoteEvent(s.g.roomId, s.server, '11', {
          type: kind === 'rejected'
            ? 'm.room.power_levels'
            : kind === 'redaction'
            ? 'm.room.redaction'
            : 'm.room.message',
          sender: s.user,
          ...(kind === 'rejected' ? { state_key: '' } : {}),
          content: kind === 'redaction' ? { redacts: '$unknown' } : {},
          prev_events: [s.joinId],
          auth_events: await authAt(s.g.room, {
            type: kind === 'rejected'
              ? 'm.room.power_levels'
              : kind === 'redaction'
              ? 'm.room.redaction'
              : 'm.room.message',
            sender: s.user,
            content: {},
            ...(kind === 'rejected' ? { state_key: '' } : {}),
          }, s.joinId),
          depth: 100,
          origin_server_ts: 200,
        });
        const left = await msg(s, 'left', [String(parent.event_id)], 101);
        const right = await msg(s, 'right', [String(parent.event_id)], 102);
        const tip = await msg(s, 'merge', [
          String(left.event_id),
          String(right.event_id),
        ], 103);
        // Wire order is not dependency order; receipts retain input order.
        const batch = [tip, right, parent, left];
        const out = await ingestRemote(s.g.room, batch, s.server.name, s.deps);
        assertEquals(
          out.map((o) => o.eventId),
          batch.map((p) => String(p.event_id)),
        );
        assertEquals(out.map((o) => o.outcome), [
          'accepted',
          'accepted',
          kind === 'rejected' ? 'rejected' : 'accepted',
          'accepted',
        ]);
        assertEquals(s.calls.missingEvents, []);
        assertEquals(s.calls.stateIds, []);
        assertEquals(s.calls.event, []);
        assertEquals(s.calls.eventAuth, []);
        assertEquals(await frontierOf(s.g.room), [String(tip.event_id)]);
        await s.g.room.tx(async (tx) => {
          for (const pdu of batch) {
            assertEquals(
              (await tx.events.getStatus(String(pdu.event_id)))?.grounding,
              'grounded',
            );
          }
          if (kind === 'redaction') {
            assertEquals(
              (await tx.waits.of(String(parent.event_id))).map((w) => w.kind),
              ['redaction'],
            );
          }
        });
      });
    });
  }
});

Deno.test('missing: pushed parents cannot lend state recovery permission to a batch', async () => {
  await withStore(async (store) => {
    const s = await setup(store);
    const far = await msg(s, 'far', [s.joinId], 100);
    const parent = await msg(s, 'parent', [String(far.event_id)], 101);
    const tip = await msg(s, 'tip', [String(parent.event_id)], 102);
    const recording = fakeFetcher({
      stateIds: new Map([[String(far.event_id), {
        pduIds: [s.g.createId, s.joinId],
        authChainIds: [],
      }]]),
      event: new Map([[String(far.event_id), far]]),
    });
    s.deps.fetcher = recording.fetcher;
    const out = await ingestRemote(
      s.g.room,
      [tip, parent],
      s.server.name,
      s.deps,
    );
    assertEquals(out.map((o) => o.outcome), ['pending', 'pending']);
    assertEquals(out[0].error, null); // the child supplied its own direct parent
    assert(out[1].error?.includes('prev_events')); // the parent withheld its prev
    assertEquals(recording.calls.missingEvents.length, 2);
    assertEquals(recording.calls.stateIds, []);
    assertEquals(recording.calls.event, []);
    assertEquals(await frontierOf(s.g.room), [s.joinId]);
  });
});

Deno.test('missing: request shape (earliest = our extremities); answers land live in depth order', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m1:test' });
    const p0 = await msg(s, 'p0', [s.joinId], 50);
    const p1 = await msg(s, 'p1', [String(p0.event_id)], 51);
    const recording = fakeFetcher({
      missingEvents: [p1, p0], // deliberately out of order
    });
    s.deps.fetcher = recording.fetcher;
    const pushed = await msg(s, 'pushed', [String(p1.event_id)], 52);
    const outcomes = await ingestRemote(
      s.g.room,
      [pushed],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'accepted');
    // the request shape: one call, earliest = our extremities, latest =
    // the pushed event, limit = missinglimit
    assertEquals(recording.calls.missingEvents.length, 1);
    assertEquals(recording.calls.missingEvents[0].latest, [
      String(pushed.event_id),
    ]);
    assertEquals(recording.calls.missingEvents[0].earliest, [s.joinId]);
    assertEquals(recording.calls.missingEvents[0].limit, 10);
    // positions prove the ingest order: p0, p1, pushed
    const offsets = await s.g.room.tx(async (tx) => {
      const at = async (id: string) =>
        (await tx.segments.positionOf(id))?.offset ?? null;
      return {
        p0: await at(String(p0.event_id)),
        p1: await at(String(p1.event_id)),
        pushed: await at(String(pushed.event_id)),
      };
    });
    assert(
      offsets.p0 !== null && offsets.p1 !== null && offsets.pushed !== null,
    );
    assert(offsets.p0 < offsets.p1 && offsets.p1 < offsets.pushed);
    assertEquals(await frontierOf(s.g.room), [String(pushed.event_id)]);
  });
});

for (const answer of ['empty', 'partial', 'unavailable', 'shared-gap']) {
  Deno.test(
    'missing: pushed own prevs must be supplied before state recovery: ' +
      answer,
    async () => {
      await withStore(async (store) => {
        const s = await setup(store);
        const withheld = await msg(s, 'withheld', [s.joinId], 50);
        const returned = await msg(s, 'returned', [
          answer === 'shared-gap' ? withheld.event_id! : s.joinId,
        ], 51);
        const pushed = await msg(s, 'pushed', [
          withheld.event_id!,
          returned.event_id!,
        ], 52);
        const recording = fakeFetcher({
          missingEvents: answer === 'partial' || answer === 'shared-gap'
            ? [returned]
            : [],
          stateIds: new Map([[withheld.event_id!, {
            pduIds: [s.g.createId, s.joinId],
            authChainIds: [],
          }]]),
          event: new Map([[withheld.event_id!, withheld]]),
        });
        if (answer === 'unavailable') {
          recording.fetcher.missingEvents = () => {
            throw new UpstreamHttpError(503, 'federation');
          };
        }
        s.deps.fetcher = recording.fetcher;
        const [out] = await ingestRemote(
          s.g.room,
          [pushed],
          s.server.name,
          s.deps,
        );
        assertEquals(recording.calls.stateIds, []);
        assertEquals(recording.calls.event, []);
        assertEquals(out.outcome, 'pending');
        assert(out.error?.includes('prev_events'));
        await s.g.room.tx(async (tx) => {
          assertEquals(await tx.events.get(withheld.event_id!), null);
          assertEquals(await tx.state.eventStateAfter(pushed.event_id!), null);
          assertEquals(await tx.segments.positionOf(pushed.event_id!), null);
        });
      });
    },
  );
}

Deno.test('missing: budget exhausted → pending + wait; the later arrival resumes it', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!m2:test',
      deps: { limits: { waitMs: 0, limit: 10, budgetMs: 0 } },
    });
    const parent = await msg(s, 'parent', [s.joinId], 50);
    const orphan = await msg(s, 'orphan', [String(parent.event_id)], 51);
    const first = await ingestRemote(s.g.room, [orphan], s.server.name, s.deps);
    assertEquals(first[0].outcome, 'pending');
    await s.g.room.tx(async (tx) => {
      const status = await tx.events.getStatus(String(orphan.event_id));
      assertEquals(status?.standing, 'rejected');
      assertEquals(status?.grounding, 'pending');
      const waits = await tx.waits.of(String(orphan.event_id));
      assertEquals(waits.map((w) => w.missing), [String(parent.event_id)]);
      assertEquals(waits[0].kind, 'prev');
      // no position while pending
      assertEquals(await tx.segments.positionOf(String(orphan.event_id)), null);
    });
    // the parent arrives (its own batch) — the resume driver re-runs the
    // orphan after the lock releases
    const second = await ingestRemote(
      s.g.room,
      [parent],
      s.server.name,
      s.deps,
    );
    assertEquals(second[0].outcome, 'accepted');
    await s.g.room.tx(async (tx) => {
      const status = await tx.events.getStatus(String(orphan.event_id));
      assertEquals(status?.standing, 'accepted');
      assertEquals(status?.grounding, 'grounded');
      assert((await tx.segments.positionOf(String(orphan.event_id))) !== null);
      assertEquals((await tx.waits.of(String(orphan.event_id))).length, 0);
      // the grounding transition is on the change log (R11)
      const transitions = (await tx.changes.after(0, 500)).filter((c) =>
        c.kind === 'transition' && c.event === String(orphan.event_id)
      );
      assertEquals(transitions.length, 1);
      const data = JSON.parse(transitions[0].data) as {
        from: { grounding: string };
        grounding: string;
      };
      assertEquals(data.from.grounding, 'pending');
      assertEquals(data.grounding, 'grounded');
    });
    assertEquals(await frontierOf(s.g.room), [String(orphan.event_id)]);
  });
});

Deno.test('missing: a re-sent orphan is accepted once its prev has arrived (TestUnrejectRejectedEvents shape)', async () => {
  await withStore(async (store) => {
    const s = await setup(store, {
      roomId: '!m3:test',
      deps: { limits: { waitMs: 0, limit: 10, budgetMs: 0 } },
    });
    const parent = await msg(s, 'parent', [s.joinId], 50);
    const orphan = await msg(s, 'orphan', [String(parent.event_id)], 51);
    const first = await ingestRemote(s.g.room, [orphan], s.server.name, s.deps);
    assertEquals(first[0].outcome, 'pending');
    const parentOut = await ingestRemote(
      s.g.room,
      [parent],
      s.server.name,
      s.deps,
    );
    assertEquals(parentOut[0].outcome, 'accepted');
    // the resume driver re-evaluated the orphan the moment its parent
    // landed; the re-sent copy is therefore the grounded receipt (ruling
    // B — a redelivery is never a second write), and the event is
    // accepted either way
    const again = await ingestRemote(s.g.room, [orphan], s.server.name, s.deps);
    assertEquals(again[0].outcome, 'known');
    const status = await s.g.room.tx((tx) =>
      tx.events.getStatus(String(orphan.event_id))
    );
    assertEquals(status?.standing, 'accepted');
    assertEquals(status?.grounding, 'grounded');
  });
});

Deno.test('missing: /state_ids + /event packs the gap tip with its fetched state; evidence is never state-at-event', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m4:test' });
    // the gap tip: a member join for zoe, whom we never saw, citing a
    // prev that is genuinely absent — its before-state can only be the
    // remote's answer (R5 imported, G1)
    const zoe = await remoteEvent(s.g.roomId, s.server, '11', {
      type: 'm.room.member',
      sender: '@zoe:remote.test',
      state_key: '@zoe:remote.test',
      content: { membership: 'join' },
      prev_events: ['$zoe-parent-we-never-held'],
      auth_events: await authAt(s.g.room, {
        type: 'm.room.member',
        sender: '@zoe:remote.test',
        state_key: '@zoe:remote.test',
        content: { membership: 'join' },
      }, s.joinId),
      depth: 50,
      origin_server_ts: 150,
    });
    // the state at zoe: the room's full current state (held) plus a
    // topic we do NOT hold
    const localServer = await testRemoteServer();
    s.deps.keys = fakeKeyResolver(s.server, localServer);
    const topic = await remoteEvent(s.g.roomId, localServer, '11', {
      type: 'm.room.topic',
      sender: s.g.creator,
      state_key: '',
      content: { topic: 'on the wire' },
      prev_events: [s.joinId],
      auth_events: await authAt(s.g.room, {
        type: 'm.room.topic',
        sender: s.g.creator,
        state_key: '',
        content: { topic: 'on the wire' },
      }, s.joinId),
      depth: 49,
      origin_server_ts: 140,
    });
    const stateIds = await s.g.room.tx(async (tx) => {
      const stay = await tx.segments.openStay();
      const group = await tx.state.current(stay!.id);
      const ids = [...(await tx.state.groupMap(group!)).values()];
      return ids;
    });
    const pulled = await msg(s, 'pulled', [String(zoe.event_id)], 51);
    const recording = fakeFetcher({
      missingEvents: [pulled],
      stateIds: new Map([[String(zoe.event_id), {
        pduIds: [...stateIds, String(topic.event_id)],
        authChainIds: [s.g.createId],
      }]]),
      event: new Map([
        [String(zoe.event_id), zoe],
        [String(topic.event_id), topic],
      ]),
    });
    s.deps.fetcher = recording.fetcher;
    const pushed = await msg(s, 'pushed', [String(pulled.event_id)], 52);
    const outcomes = await ingestRemote(
      s.g.room,
      [pushed],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'accepted');
    // the /state_ids call named the gap tip
    assertEquals(recording.calls.stateIds, [String(zoe.event_id)]);
    await s.g.room.tx(async (tx) => {
      // the gap tip landed LIVE with the imported boundary (R5, G1)
      const status = await tx.events.getStatus(String(zoe.event_id));
      assertEquals(status?.standing, 'accepted');
      assertEquals(status?.grounding, 'grounded');
      const before = await tx.state.eventStateBefore(String(zoe.event_id));
      assert(before !== null && before.provenance === 'imported');
      const beforeMap = await tx.state.groupMap(before.group);
      // the fetched topic is in the boundary
      assertEquals(
        beforeMap.get('m.room.topic\0'),
        String(topic.event_id),
      );
      // evidence: bytes held, no state refs, no position — never an
      // answer to "state at" (G2)
      const evStatus = await tx.events.getStatus(String(topic.event_id));
      assertEquals(evStatus?.grounding, 'evidence');
      assertEquals(
        await tx.state.eventStateAfter(String(topic.event_id)),
        null,
      );
      assertEquals(
        await tx.segments.positionOf(String(topic.event_id)),
        null,
      );
    });
    // and the pushed event grounds against the packed tip
    assertEquals(
      await frontierOf(s.g.room),
      [s.joinId, String(pushed.event_id)].sort(),
    );
    // a PDU citing the evidence event as prev does NOT ground on it
    const citing = await msg(s, 'cites evidence', [String(topic.event_id)], 52);
    const second = await ingestRemote(s.g.room, [citing], s.server.name, {
      ...s.deps,
      limits: { waitMs: 0, limit: 10, budgetMs: 0 },
    });
    assertEquals(second[0].outcome, 'pending');
  });
});

Deno.test('missing: a pulled event with its own missing prev — the chase names the gap tip BEHIND it', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m5:test' });
    const far = await msg(s, 'far', [s.joinId], 50);
    const near = await msg(s, 'near', [String(far.event_id)], 51);
    const recording = fakeFetcher({
      missingEvents: [near],
      stateIds: new Map([[String(far.event_id), {
        pduIds: [s.g.createId, s.joinId],
        authChainIds: [],
      }]]),
      event: new Map([[String(far.event_id), far]]),
    });
    s.deps.fetcher = recording.fetcher;
    const pushed = await msg(s, 'pushed', [String(near.event_id)], 52);
    const outcomes = await ingestRemote(
      s.g.room,
      [pushed],
      s.server.name,
      s.deps,
    );
    // the chain grounds through the packed far tip: far (imported), then
    // near, then pushed — all in one batch in depth order
    assertEquals(outcomes[0].outcome, 'accepted');
    // /state_ids named the FAR event (the gap tip), never the held near
    assert(recording.calls.stateIds.includes(String(far.event_id)));
    assert(!recording.calls.stateIds.includes(String(near.event_id)));
    await s.g.room.tx(async (tx) => {
      for (
        const id of [far.event_id, near.event_id, pushed.event_id].map(String)
      ) {
        const status = await tx.events.getStatus(id);
        assertEquals(status?.grounding, 'grounded', id);
        assertEquals(status?.standing, 'accepted', id);
      }
      // far's own prev is held — its before-state resolved from the
      // parent it cites, not the fetched boundary (P15)
      const before = await tx.state.eventStateBefore(String(far.event_id));
      assert(before !== null && before.provenance === 'dag');
    });
    assertEquals(await frontierOf(s.g.room), [String(pushed.event_id)]);
  });
});

Deno.test('missing: a format-dropped answer event is terminal — no /state_ids fallthrough (the BadJSON case)', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m6:test' });
    // a bad event: signed fine, then its content gains a float — the
    // format check rejects it before any signature check
    const bad = await msg(s, 'bad', [s.joinId], 50);
    bad.content.score = 1.5;
    const recording = fakeFetcher({
      missingEvents: [bad],
      stateIds: new Map(),
    });
    s.deps.fetcher = recording.fetcher;
    const pushed = await msg(s, 'pushed', [String(bad.event_id)], 51);
    const outcomes = await ingestRemote(
      s.g.room,
      [pushed],
      s.server.name,
      s.deps,
    );
    // no /state_ids for the dropped event, in this chain or ever here
    assertEquals(recording.calls.stateIds, []);
    // the bad event is NOT stored (G10: stored bytes are verified bytes);
    // the dependent waits as pending
    assertEquals(outcomes[0].outcome, 'pending');
    assertEquals(
      await s.g.room.tx((tx) => tx.events.get(String(bad.event_id))),
      null,
    );
    const status = await s.g.room.tx((tx) =>
      tx.events.getStatus(String(pushed.event_id))
    );
    assertEquals(status?.grounding, 'pending');
  });
});

Deno.test('missing: later child after bad JSON retains the trusted frontier when recovery replies are malformed or absent', async () => {
  await withStore(async (store) => {
    const s = await setup(store);
    const bad = await msg(s, 'invalid float', [s.joinId], 50);
    bad.content.bad_val = 1.1;
    const good = await msg(s, 'Message 2', [String(bad.event_id)], 51);
    const next = await msg(s, 'Message 3', [String(good.event_id)], 52);
    const initial = fakeFetcher({ missingEvents: [bad] });
    s.deps.fetcher = initial.fetcher;
    assertEquals(
      (await ingestRemote(s.g.room, [good], s.server.name, s.deps))[0].outcome,
      'pending',
    );
    assertEquals(initial.calls.stateIds, []);
    assertEquals(initial.calls.missingEvents[0].earliest, [s.joinId]);
    assertEquals(initial.calls.missingEvents[0].latest, [
      String(good.event_id),
    ]);
    // Complement's second handler returns {}, which decodes as no events.
    // Held pending bytes do not grant state recovery for the new pushed PDU.
    const missing: { earliest: string[]; latest: string[] }[] = [];
    const stateIds: string[] = [];
    s.deps.fetcher.missingEvents = (_room, earliest, latest) => {
      missing.push({ earliest: [...earliest], latest: [...latest] });
      return Promise.resolve([]);
    };
    s.deps.fetcher.stateIds = (_room, event) => {
      stateIds.push(event);
      throw new UpstreamHttpError(404, 'federation');
    };
    assertEquals(
      (await ingestRemote(s.g.room, [next], s.server.name, s.deps))[0].outcome,
      'pending',
    );
    assertEquals(missing, [{
      earliest: [s.joinId],
      latest: [String(next.event_id)],
    }]);
    assertEquals(stateIds, []);
    assertEquals(await frontierOf(s.g.room), [s.joinId]);
    await s.g.room.tx(async (tx) => {
      assertEquals(await tx.events.get(String(bad.event_id)), null);
      for (const id of [good.event_id, next.event_id].map(String)) {
        assertEquals((await tx.events.getStatus(id))?.grounding, 'pending');
        assertEquals(await tx.state.eventStateAfter(id), null);
        assertEquals(await tx.segments.positionOf(id), null);
      }
    });
  });
});

Deno.test('missing: an unfetchable auth chain stores the gap tip rejected as evidence — it grounds nothing', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m7:test' });
    const far = await msg(s, 'far', [s.joinId], 50);
    const pulled = await msg(s, 'pulled', [String(far.event_id)], 51);
    const recording = fakeFetcher({
      missingEvents: [pulled],
      stateIds: new Map([[String(far.event_id), {
        pduIds: [s.g.createId],
        authChainIds: ['$unfetchable'],
      }]]),
      event: new Map([
        [String(far.event_id), far],
        ['$unfetchable', null],
      ]),
    });
    s.deps.fetcher = recording.fetcher;
    const pushed = await msg(s, 'pushed', [String(pulled.event_id)], 52);
    const outcomes = await ingestRemote(
      s.g.room,
      [pushed],
      s.server.name,
      s.deps,
    );
    // TestCorruptedAuthChain: the tip must not become accepted — a
    // standing rejected record, never grounding (requirements §4.2 R5)
    assertEquals(outcomes[0].outcome, 'pending');
    // Its direct parent WAS divulged by missing-events. Failed auth behind
    // that pulled parent is not a missing-parent refusal of the pushed PDU.
    assertEquals(outcomes[0].error, null);
    await s.g.room.tx(async (tx) => {
      const status = await tx.events.getStatus(String(far.event_id));
      assertEquals(status?.standing, 'rejected');
      assertEquals(status?.grounding, 'evidence');
      assertEquals(await tx.state.eventStateAfter(String(far.event_id)), null);
    });
  });
});

Deno.test('missing: an auth-chain event that fails its own auth check is stored rejected as evidence', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m8:test' });
    const far = await msg(s, 'far', [s.joinId], 50);
    const pulled = await msg(s, 'pulled', [String(far.event_id)], 51);
    // a state event whose declared auth events are unresolvable — it
    // fails checkAuthChain (rule 2.2) under the lock
    const shady = await remoteEvent(s.g.roomId, s.server, '11', {
      type: 'm.room.topic',
      sender: '@zoe:remote.test',
      state_key: '',
      content: { topic: 'shady' },
      prev_events: [s.joinId],
      auth_events: ['$nonexistent'],
      depth: 49,
      origin_server_ts: 140,
    });
    const recording = fakeFetcher({
      missingEvents: [pulled],
      stateIds: new Map([[String(far.event_id), {
        pduIds: [s.g.createId, s.joinId],
        authChainIds: [String(shady.event_id)],
      }]]),
      event: new Map([
        [String(far.event_id), far],
        [String(shady.event_id), shady],
      ]),
    });
    s.deps.fetcher = recording.fetcher;
    const pushed = await msg(s, 'pushed', [String(pulled.event_id)], 52);
    const outcomes = await ingestRemote(
      s.g.room,
      [pushed],
      s.server.name,
      s.deps,
    );
    assertEquals(outcomes[0].outcome, 'accepted');
    const status = await s.g.room.tx((tx) =>
      tx.events.getStatus(String(shady.event_id))
    );
    assertEquals(status?.standing, 'rejected');
    assertEquals(status?.grounding, 'evidence');
  });
});

Deno.test('missing: a wait for an unknown redaction target is applied when the target arrives', async () => {
  await withStore(async (store) => {
    const s = await setup(store, { roomId: '!m9:test' });
    const target = await msg(s, 'target', [s.joinId], 50);
    // a remote redaction for a target we do not hold: accepted, waits
    const redaction = await remoteEvent(s.g.roomId, s.server, '11', {
      type: 'm.room.redaction',
      sender: s.user,
      content: { redacts: String(target.event_id) },
      prev_events: [s.joinId],
      auth_events: await authAt(s.g.room, {
        type: 'm.room.redaction',
        sender: s.user,
        content: {},
      }, s.joinId),
      depth: 51,
      origin_server_ts: 160,
    });
    const first = await ingestRemote(
      s.g.room,
      [redaction],
      s.server.name,
      s.deps,
    );
    assertEquals(first[0].outcome, 'accepted');
    await s.g.room.tx(async (tx) => {
      const waits = await tx.waits.of(String(redaction.event_id));
      assertEquals(waits.length, 1);
      assertEquals(waits[0].kind, 'redaction');
      // no effect yet
      const effects = (await tx.changes.after(0, 500)).filter((c) =>
        c.kind === 'redaction'
      );
      assertEquals(effects.length, 0);
    });
    // the target arrives — the effect lands (the sender may redact his
    // own event: matching sender domains)
    const second = await ingestRemote(
      s.g.room,
      [target],
      s.server.name,
      s.deps,
    );
    assertEquals(second[0].outcome, 'accepted');
    await s.g.room.tx(async (tx) => {
      assertEquals((await tx.waits.of(String(redaction.event_id))).length, 0);
      const effects = (await tx.changes.after(0, 500)).filter((c) =>
        c.kind === 'redaction' && c.event === String(redaction.event_id)
      );
      assertEquals(effects.length, 1);
      assertEquals(
        (JSON.parse(effects[0].data) as { target: string }).target,
        String(target.event_id),
      );
    });
  });
});
