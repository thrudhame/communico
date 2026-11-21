// tests/room-join.test.ts — joining a room hosted elsewhere (3c-2):
// the returned snapshot becomes the imported boundary of a new stay
// (sole extremity, evidence, publication, membership change); via
// fail-over on network failure and 404, abort on 403; unusable snapshot
// events are excluded without blocking an otherwise authorized join;
// missing critical auth or a returned join that does not match is refused.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { assertRoomAcl } from '#engine/federation/acl.ts';
import { joinRemote } from '#engine/room/join.ts';
import { setMembershipAdmission } from '#engine/room/hooks.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import type { Conn } from '#engine/store/db.ts';
import { finalizeBuilt } from '#engine/room/build.ts';
import { getRulebook } from '#engine/rulebook/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openRoom, type Room, roomSchema } from '#engine/room/index.ts';
import { mapEntries } from '#engine/room/state.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  remoteEvent,
} from './fixtures/remote.ts';
import {
  fakeMessage,
  type FakeRoom,
  makeFakeRoom,
} from './fixtures/remote-room.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { assertAuthored } from './fixtures/authored.ts';

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
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const ANNA = '@anna:test';

Deno.test('join remote: selected scope fences network intent and final room commits', async (t) => {
  for (
    const phase of [
      'before-network',
      'signing',
      'intent',
      'intent-final',
      'response',
      'snapshot-final',
      'resident-final',
    ]
  ) {
    await t.step(phase, () =>
      withStore(async (store) => {
        const fr = await makeFakeRoom({ roomId: '!scope-join:remote.test' });
        const signer = await testSigner();
        const { deps, calls } = await joinDepsFor(fr);
        const resident = phase === 'resident-final';
        if (resident) {
          await joinRemote(store, {
            roomId: fr.roomId,
            user: ANNA,
            via: [fr.server.name],
            signer,
            deps,
          });
        }
        const user = resident ? '@bea:test' : ANNA;
        const makeBefore = calls.makeJoin.length;
        const sendBefore = calls.sendJoin.length;
        let current = phase !== 'before-network';
        let preparations = 0;
        let durableChecks = 0;
        const unavailable = () => {
          throw new MatrixError(
            503,
            'M_UNAVAILABLE',
            'selected scope unavailable',
          );
        };
        setMembershipAdmission(
          store,
          (roomId, localUser, allowAbsent) => {
            assertEquals([roomId, localUser, allowAbsent], [
              fr.roomId,
              user,
              true,
            ]);
            if (!current) unavailable();
            preparations++;
            const final = phase.endsWith('-final') &&
              preparations >= (resident ? 3 : 2);
            let checks = 0;
            return Promise.resolve({
              async check(conn: Conn) {
                // This must be the intent's existing server connection, not a nested read.
                await conn.query(
                  'SELECT COUNT(*) AS n FROM federation_join_attempts',
                );
                durableChecks++;
                if (phase === 'intent') unavailable();
                if (phase === 'intent-final') current = false;
              },
              checkCurrent() {
                if (final && ++checks === 2) current = false;
                if (!current) unavailable();
              },
            });
          },
        );
        const originalSend = deps.fetcher.sendJoin;
        deps.fetcher.sendJoin = async (...args) => {
          const result = await originalSend(...args);
          if (phase === 'response') current = false;
          return result;
        };
        let signatures = 0;
        const error = await assertRejects(
          () =>
            joinRemote(store, {
              roomId: fr.roomId,
              user,
              via: [fr.server.name],
              signer: {
                ...signer,
                async sign(bytes) {
                  signatures++;
                  const result = await signer.sign(bytes);
                  if (phase === 'signing') current = false;
                  return result;
                },
              },
              deps,
            }),
          MatrixError,
          'selected scope unavailable',
        );
        assertEquals(error.status, 503);
        const beforeIntent = [
          'before-network',
          'signing',
          'intent',
          'intent-final',
        ].includes(
          phase,
        );
        assertEquals(
          calls.makeJoin.length - makeBefore,
          phase === 'before-network' ? 0 : 1,
        );
        assertEquals(calls.sendJoin.length - sendBefore, beforeIntent ? 0 : 1);
        assertEquals(signatures, phase === 'before-network' ? 0 : 1);
        if (phase.startsWith('intent')) assertEquals(durableChecks, 1);
        const attempts = await (await store.server()).query(
          'SELECT user_id FROM federation_join_attempts',
        );
        assertEquals(attempts.length, beforeIntent ? 0 : 1);
        // A remotely uncertain join keeps its cleanup obligation, never local participation.
        try {
          const room = await openRoom(store, fr.roomId);
          await room.tx(async (tx) => {
            const stay = await tx.segments.openStay();
            if (!resident) assertEquals(stay, null);
            if (stay !== null) {
              const group = await tx.state.current(stay.id);
              assertEquals(
                group === null
                  ? null
                  : await tx.state.groupKey(group, 'm.room.member', user),
                null,
              );
            }
            const local = (await tx.changes.after(0, 10000)).filter((change) =>
              change.kind === 'local-participation' &&
              JSON.parse(change.data).user === user
            );
            assertEquals(local, []);
          });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
      }));
  }
});

Deno.test('join remote: committed batch receipt precedes new local scope admission', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!scope-replay:remote.test' });
    const { deps } = await joinDepsFor(fr);
    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer: await testSigner(),
      deps,
    });
    const room = await openRoom(store, fr.roomId);
    const pdu = await room.tx(async (tx) =>
      JSON.parse((await tx.events.get(result.eventId))!.pdu) as Pdu
    );
    let current = true, preparations = 0;
    setMembershipAdmission(store, (_room, user, absent) => {
      assertEquals([user, absent], [ANNA, true]);
      preparations++;
      const checkCurrent = () => {
        if (!current) {
          throw new MatrixError(
            503,
            'M_UNAVAILABLE',
            'selected scope unavailable',
          );
        }
      };
      checkCurrent();
      return Promise.resolve({ checkCurrent });
    });
    const call = () =>
      ingestRemote(
        room,
        [pdu],
        fr.server.name,
        {
          ...deps,
          limits: { waitMs: 0, limit: 100, budgetMs: 8000 },
          ungroundedMs: 0,
          localJoin: { eventId: result.eventId, userId: ANNA },
        },
        'pulled',
        'scope-replay',
      );
    const first = await call();
    assertEquals(first[0].outcome, 'known');
    const head = await room.tx((tx) => tx.changes.head());
    const prepared = preparations;
    current = false;
    assertEquals(await call(), first);
    assertEquals(preparations, prepared);
    assertEquals(await room.tx((tx) => tx.changes.head()), head);
  });
});

Deno.test('key fault ownership: remote join preserves local faults and never tries another resident', async () => {
  for (const phase of ['make-join', 'snapshot', 'returned-signature']) {
    await withStore(async (store) => {
      const fr = await makeFakeRoom({ roomId: '!local-key:remote.test' });
      const fault = new Error('local ' + phase);
      let returning = false;
      const valid = fakeKeyResolver(fr.server, await testRemoteServer());
      const signer = await testSigner();
      const { fetcher, calls } = fakeFetcher({
        makeJoin: (user) => {
          if (phase === 'make-join') throw fault;
          return fr.makeJoinAnswer(user);
        },
        sendJoin: async (event) => {
          const result = await fr.acceptSendJoin(event);
          if (phase === 'returned-signature') {
            result.event.signatures![fr.server.name] = {
              'ed25519:local': 'invalid',
            };
          }
          returning = true;
          return result;
        },
      });
      assertStrictEquals(
        await assertRejects(() =>
          joinRemote(store, {
            roomId: fr.roomId,
            user: ANNA,
            via: [fr.server.name, 'other.test'],
            signer,
            deps: {
              fetcher,
              self: 'test',
              keys: {
                verifyEventSignature: (args) => {
                  if (
                    returning &&
                    (phase === 'snapshot' || args.keyId === 'ed25519:local')
                  ) throw fault;
                  return valid.verifyEventSignature(args);
                },
              },
            },
          })
        ),
        fault,
      );
      assertEquals(calls.makeJoin.length, 1);
      await assertRejects(() => openRoom(store, fr.roomId));
    });
  }
});

Deno.test('join remote: candidate ACL refusal fails over, own-server refusal aborts', async (t) => {
  for (
    const mode of [
      'snapshot candidate',
      'known candidate',
      'snapshot self',
      'known self',
    ]
  ) {
    await t.step(mode, () =>
      withStore(async (store) => {
        const fr = await makeFakeRoom({ roomId: '!acl-failover:remote.test' });
        await fr.addEvent({
          type: 'm.room.server_acl',
          state_key: '',
          content: {
            allow: ['*'],
            deny: [mode.endsWith('self') ? 'test' : 'blocked.test'],
          },
        });
        const { fetcher, calls } = fakeFetcher({
          makeJoin: async (user, via) => {
            if (mode.startsWith('known')) {
              // Exercise the same pre-dial owner used by the production client.
              await assertRoomAcl(store, fr.roomId, 'test');
              await assertRoomAcl(store, fr.roomId, via);
            }
            return fr.makeJoinAnswer(user);
          },
          sendJoin: (event) => fr.acceptSendJoin(event),
        });
        const signer = await testSigner();
        const cleaned: string[] = [];
        const deps = {
          fetcher,
          keys: fakeKeyResolver(fr.server, await testRemoteServer()),
          self: 'test',
          leave: async (attempt: { userId: string; destination: string }) => {
            const template = fr.makeLeaveAnswer(attempt.userId);
            const leave = await finalizeBuilt(
              {
                ...template.event,
                origin_server_ts: Date.now(),
                hashes: { sha256: '' },
                signatures: {},
              },
              getRulebook(template.roomVersion),
              signer,
            );
            // This in-process resident applies the actual signed self-leave,
            // just as its send_join adapter applies the actual signed join.
            await fr.acceptSendJoin(leave);
            cleaned.push(attempt.destination);
          },
        };
        if (mode.startsWith('known')) {
          const room = await openRoom(store, fr.roomId, { create: true });
          await room.tx(async (tx) => {
            for (const pdu of fr.events.values()) {
              await tx.events.insert(String(pdu.event_id), JSON.stringify(pdu));
            }
            const group = await tx.materialize.newGroup(
              null,
              mapEntries(fr.afterOf.get(fr.tipId)!),
            );
            const stay = await tx.segments.create({
              kind: 'stay',
              prev: null,
              opening_group: group,
            });
            await tx.materialize.setCurrent(stay, group);
            await tx.segments.close(stay);
          });
        }
        const join = () =>
          joinRemote(store, {
            roomId: fr.roomId,
            user: ANNA,
            via: ['blocked.test', fr.server.name],
            signer,
            deps,
          });
        if (mode.endsWith('self')) {
          assertEquals((await assertRejects(join, MatrixError)).status, 403);
          assertEquals(calls.makeJoin.length, 1);
        } else {
          assertEquals((await join()).roomId, fr.roomId);
          assertEquals(calls.makeJoin.length, 2);
          assertEquals(calls.sendJoin.length, mode.startsWith('known') ? 1 : 2);
        }
        assertEquals(
          cleaned,
          mode.startsWith('snapshot') ? ['blocked.test'] : [],
        );
      }));
  }
});

async function joinDepsFor(fr: FakeRoom) {
  const { fetcher, calls } = fakeFetcher({
    makeJoin: (userId) => fr.makeJoinAnswer(userId),
    sendJoin: async (event) => {
      await assertAuthored(event);
      return await fr.acceptSendJoin(event);
    },
  });
  return {
    calls,
    deps: {
      keys: fakeKeyResolver(fr.server, await testRemoteServer()),
      fetcher,
      self: 'test',
    },
  };
}

async function frontierOf(room: Room): Promise<string[]> {
  return await room.tx(async (tx) => {
    const stay = await tx.segments.openStay();
    return stay === null ? [] : await tx.extremities.frontier(stay.id);
  });
}

for (const restricted of [false, true]) {
  Deno.test(`join remote: returned join signature ${restricted ? 'required when restricted' : 'optional otherwise'}`, async (t) => {
    for (
      const answer of [
        'omitted',
        'unsigned',
        'invalid signature',
        'unobtainable key',
        'signed',
        'mismatched id',
      ]
    ) {
      await t.step(answer, async () => {
        await withStore(async (store) => {
          const fr = await makeFakeRoom({
            roomId: '!returned:remote.test',
            joinRule: restricted ? 'restricted' : 'public',
          });
          const keys = fakeKeyResolver(fr.server, await testRemoteServer());
          let ours: Pdu;
          let returned: Pdu;
          const { fetcher } = fakeFetcher({
            makeJoin: (user) => {
              const template = fr.makeJoinAnswer(user);
              if (restricted) {
                template.event.content.join_authorised_via_users_server =
                  fr.creator;
                const authoriser = fr.afterOf.get(fr.tipId)!.get(
                  'm.room.member\0' + fr.creator,
                )!;
                template.event.auth_events!.push(authoriser);
              }
              return template;
            },
            sendJoin: async (event) => {
              ours = structuredClone(event);
              const response = await fr.acceptSendJoin(event);
              // Synapse returns the event even without a resident signature.
              if (answer === 'unsigned') {
                response.event.signatures = structuredClone(event.signatures);
              } else if (answer === 'invalid signature') {
                response.event.signatures![fr.server.name] = {
                  [fr.server.keyId]: 'invalid',
                };
              } else if (answer === 'unobtainable key') {
                response.event.signatures![fr.server.name] = {
                  'ed25519:unobtainable': 'invalid',
                };
              } else if (answer === 'mismatched id') {
                response.event.content = { membership: 'leave' };
              }
              returned = structuredClone(response.event);
              return answer === 'omitted'
                ? { state: response.state, authChain: response.authChain }
                : response;
            },
          });
          const join = () =>
            joinRemote(store, {
              roomId: fr.roomId,
              user: ANNA,
              via: [fr.server.name],
              signer,
              content: restricted
                ? { join_authorised_via_users_server: fr.creator }
                : { displayname: 'Anna' },
              deps: {
                fetcher,
                self: 'test',
                keys: {
                  verifyEventSignature: (args) => {
                    if (args.keyId === 'ed25519:unobtainable') {
                      throw new UpstreamError('transport', {
                        phase: 'key-doc',
                        reason: 'key fetch failed',
                      });
                    }
                    return keys.verifyEventSignature(args);
                  },
                },
              },
            });
          const signer = await testSigner();
          if (
            answer === 'mismatched id' || (restricted && answer !== 'signed')
          ) {
            const error = await assertRejects(join, MatrixError);
            assertEquals(error.status, 502);
            assertEquals(
              error.responseBody().error,
              answer === 'mismatched id'
                ? 'the returned join does not match ours'
                : 'the returned join is not vouched by the resident',
            );
            await assertRejects(() => openRoom(store, fr.roomId));
            return;
          }
          const result = await join();
          const room = await openRoom(store, fr.roomId);
          await room.tx(async (tx) => {
            const stored = (await tx.events.get(result.eventId))!;
            assertEquals(
              JSON.parse(stored.pdu),
              answer === 'signed' ? returned! : ours!,
            );
            assertEquals(
              (await tx.events.getStatus(result.eventId))?.standing,
              'accepted',
            );
            const stay = (await tx.segments.openStay())!;
            const current = (await tx.state.current(stay.id))!;
            assertEquals(
              await tx.state.groupKey(current, 'm.room.member', ANNA),
              result.eventId,
            );
          });
        });
      });
    }
  });
}

Deno.test('join remote: the snapshot becomes the imported boundary of a new stay', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!j1:remote.test' });
    await fakeMessage(fr, 'hello before we arrive');
    await fakeMessage(fr, 'the wire moves');
    const { deps, calls } = await joinDepsFor(fr);
    const signer = await testSigner();

    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: [fr.server.name],
      signer,
      deps,
    });
    assertEquals(result.roomId, fr.roomId);
    assert(calls.makeJoin.length === 1);
    assert(calls.sendJoin.length === 1);

    const room = await openRoom(store, fr.roomId);
    assertEquals(await frontierOf(room), [result.eventId]);
    await room.tx(async (tx) => {
      const stay = (await tx.segments.openStay())!;
      assertEquals(stay.opened_by, result.eventId);
      // the join is positioned at the stay's origin
      assertEquals(
        await tx.segments.positionOf(result.eventId),
        { segment: stay.id, offset: 0 },
      );
      // its before-state IS the stay's opening group, provenance
      // imported (G1) — the snapshot, never recomputed
      const before = await tx.state.eventStateBefore(result.eventId);
      assert(before !== null && before.provenance === 'imported');
      assertEquals(stay.opening_group, before.group);
      // the snapshot events are evidence: bytes, no refs, no positions
      for (const id of [fr.createId, fr.powerLevelsId]) {
        const status = await tx.events.getStatus(id);
        assertEquals(status?.grounding, 'evidence');
        assertEquals(await tx.state.eventStateAfter(id), null);
        assertEquals(await tx.segments.positionOf(id), null);
      }
      // the snapshot carries the fake room's state
      assertEquals(
        await tx.state.groupKey(before.group, 'm.room.create', ''),
        fr.createId,
      );
      // the published current state has anna joined
      const current = await tx.state.current(stay.id);
      const annaId = current === null
        ? null
        : await tx.state.groupKey(current, 'm.room.member', ANNA);
      assert(annaId !== null && annaId === result.eventId);
      // the change log: the membership change and the publication, no
      // delivery intent (the resident fans the join out — we don't)
      const changes = await tx.changes.after(0, 100000);
      const membership = changes.filter((c) => c.kind === 'membership');
      assertEquals(membership.length, 1);
      assertEquals(
        JSON.parse(membership[0].data),
        { user: ANNA, from: null, to: 'join' },
      );
      const delivery = changes.filter((c) => c.kind === 'delivery');
      assertEquals(delivery.length, 0);
      // the publication moved past the opening group (the join is in)
      const published = await tx.state.publishedAt(
        stay.id,
        Number.MAX_SAFE_INTEGER,
      );
      assert(published !== null && published !== stay.opening_group);
      // the join's own event entry: grounded, the via as origin
      const joinEntry = changes.filter((c) =>
        c.kind === 'event' && c.event === result.eventId
      );
      assertEquals(joinEntry.length, 1);
      const data = JSON.parse(joinEntry[0].data) as {
        grounding: string;
        origin: string;
        stay: number;
      };
      assertEquals(data.grounding, 'grounded');
      assertEquals(data.origin, fr.server.name);
      assertEquals(data.stay, stay.id);
    });
  });
});

Deno.test('join remote: fail-over on network failure and 404; abort on 403', async () => {
  await withStore(async (store) => {
    const fr = await makeFakeRoom({ roomId: '!j2:remote.test' });
    const signer = await testSigner();
    const selfKeys = await testRemoteServer();
    // a dead first candidate (network error), the fake second
    const dead = fakeFetcher({
      makeJoin: () => {
        throw new UpstreamError('transport', {
          phase: 'make-join',
          reason: 'connection refused',
        });
      },
    });
    const { deps } = await joinDepsFor(fr);
    deps.fetcher = {
      ...deps.fetcher,
      makeJoin: (roomId, userId, versions, via) => {
        if (via === 'dead.test') {
          return dead.fetcher.makeJoin(roomId, userId, versions, via);
        }
        return Promise.resolve(fr.makeJoinAnswer(userId));
      },
      sendJoin: (_roomId, event, _via) => fr.acceptSendJoin(event),
    };
    const result = await joinRemote(store, {
      roomId: fr.roomId,
      user: ANNA,
      via: ['dead.test', fr.server.name],
      signer,
      deps,
    });
    assertEquals(result.roomId, fr.roomId);

    // a 404 M_NOT_FOUND from make_join fails over the same way
    const fr404 = await makeFakeRoom({ roomId: '!j2b:remote.test' });
    const gone = fakeFetcher({
      makeJoin: (_userId, via) => {
        if (via === 'gone.test') {
          throw new MatrixError(404, 'M_NOT_FOUND', 'not here');
        }
        return fr404.makeJoinAnswer(_userId);
      },
      sendJoin: (event) => fr404.acceptSendJoin(event),
    });
    const result404 = await joinRemote(store, {
      roomId: fr404.roomId,
      user: ANNA,
      via: ['gone.test', fr404.server.name],
      signer,
      deps: {
        keys: fakeKeyResolver(fr404.server, selfKeys),
        fetcher: gone.fetcher,
        self: 'test',
      },
    });
    assertEquals(result404.roomId, fr404.roomId);

    // a 403 aborts — no fail-over, no room file
    const fr403 = await makeFakeRoom({ roomId: '!j2c:remote.test' });
    const forbidden = fakeFetcher({
      makeJoin: () => {
        throw new MatrixError(403, 'M_FORBIDDEN', 'banned');
      },
    });
    const err = await assertRejects(() =>
      joinRemote(store, {
        roomId: fr403.roomId,
        user: ANNA,
        via: [fr403.server.name],
        signer,
        deps: {
          keys: fakeKeyResolver(fr403.server, selfKeys),
          fetcher: forbidden.fetcher,
          self: 'test',
        },
      })
    );
    assert(String(err).includes('M_FORBIDDEN'));
    await assertRejects(() => openRoom(store, fr403.roomId));
  });
});

Deno.test('join remote: rejected state is excluded; a mismatched join refuses the response', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const selfKeys = await testRemoteServer();

    // room A: the snapshot carries a state event that fails its auth
    // check (a topic with no auth events at all — rule 2)
    const frA = await makeFakeRoom({ roomId: '!j3:remote.test' });
    const badTopic = await remoteEvent(frA.roomId, frA.server, '11', {
      type: 'm.room.topic',
      sender: frA.creator,
      state_key: '',
      content: { topic: 'forged' },
      prev_events: [frA.tipId],
      auth_events: [],
      depth: 50,
    });
    const tamperedA = fakeFetcher({
      makeJoin: (userId) => frA.makeJoinAnswer(userId),
      sendJoin: (event) =>
        frA.acceptSendJoin(event, (resp) => {
          resp.state.push(badTopic);
        }),
    });
    const resultA = await joinRemote(store, {
      roomId: frA.roomId,
      user: ANNA,
      via: [frA.server.name],
      signer,
      deps: {
        keys: fakeKeyResolver(frA.server, selfKeys),
        fetcher: tamperedA.fetcher,
        self: 'test',
      },
    });
    const roomA = await openRoom(store, frA.roomId);
    await roomA.tx(async (tx) => {
      assertEquals(
        (await tx.events.getStatus(String(badTopic.event_id)))?.standing,
        'rejected',
      );
      const before = (await tx.state.eventStateBefore(resultA.eventId))!;
      assertEquals(
        await tx.state.groupKey(before.group, 'm.room.topic', ''),
        null,
      );
    });

    // room B: the returned join does not match ours — a keep-listed
    // field is tampered, so the recomputed id differs
    const frB = await makeFakeRoom({ roomId: '!j3b:remote.test' });
    const tamperedB = fakeFetcher({
      makeJoin: (userId) => frB.makeJoinAnswer(userId),
      sendJoin: (event) =>
        frB.acceptSendJoin(event, (resp) => {
          resp.event = {
            ...(resp.event as unknown as Record<string, unknown>),
            content: { membership: 'invite' },
          } as unknown as Pdu;
        }),
    });
    const errB = await assertRejects(() =>
      joinRemote(store, {
        roomId: frB.roomId,
        user: ANNA,
        via: [frB.server.name],
        signer,
        deps: {
          keys: fakeKeyResolver(frB.server, selfKeys),
          fetcher: tamperedB.fetcher,
          self: 'test',
        },
      })
    );
    assert(String(errB).includes('M_UNKNOWN'), String(errB));
    await assertRejects(() => openRoom(store, frB.roomId));
  });
});

Deno.test('join remote: unusable snapshot events do not block an authorized join', async (t) => {
  for (
    const failure of [
      'missing signature',
      'bad signature',
      'unobtainable key',
      'malformed',
      'unverifiable auth',
      'rejected create',
    ]
  ) {
    await t.step(failure, async () => {
      await withStore(async (store) => {
        const fr = await makeFakeRoom({ roomId: '!unusable:remote.test' });
        const bad = await fr.addEvent({
          type: failure === 'unverifiable auth'
            ? 'm.room.member'
            : 'm.room.name',
          state_key: failure === 'unverifiable auth' ? fr.creator : '',
          content: failure === 'unverifiable auth'
            ? { membership: 'join' }
            : { name: 'unusable' },
        });
        let dependent: Pdu | undefined;
        let descendant: Pdu | undefined;
        if (failure === 'unverifiable auth') {
          dependent = await fr.addEvent({
            type: 'm.room.member',
            state_key: fr.creator,
            content: { membership: 'leave' },
          });
          assert(dependent.auth_events?.includes(String(bad.event_id)));
          // A second rejected descendant must not re-enter the imported state.
          descendant = await fr.addEvent({
            type: 'm.room.topic',
            state_key: '',
            content: { topic: 'depends on rejected leave' },
          });
          assert(descendant.auth_events?.includes(String(dependent.event_id)));
        }
        const badId = String(bad.event_id);
        const invalidCreate = failure === 'rejected create'
          ? await remoteEvent(fr.roomId, fr.server, fr.version, {
            type: 'm.room.create',
            sender: fr.creator,
            state_key: '',
            content: { room_version: fr.version },
            prev_events: [fr.tipId],
            auth_events: [],
          })
          : undefined;
        const keys = fakeKeyResolver(fr.server, await testRemoteServer());
        const { fetcher } = fakeFetcher({
          makeJoin: (user) => fr.makeJoinAnswer(user),
          sendJoin: (event) =>
            fr.acceptSendJoin(event, (resp) => {
              if (invalidCreate) {
                resp.state.push(invalidCreate);
                return;
              }
              for (const pdu of [...resp.state, ...resp.authChain]) {
                if (pdu.event_id !== badId) continue;
                if (failure === 'malformed') {
                  pdu.depth = -1;
                } else if (failure === 'missing signature') {
                  pdu.signatures = {};
                } else {
                  pdu.signatures = {
                    [fr.server.name]: {
                      [
                        failure === 'unobtainable key'
                          ? 'ed25519:unobtainable'
                          : fr.server.keyId
                      ]: 'invalid',
                    },
                  };
                }
              }
            }),
        });
        const result = await joinRemote(store, {
          roomId: fr.roomId,
          user: ANNA,
          via: [fr.server.name],
          signer: await testSigner(),
          deps: {
            fetcher,
            self: 'test',
            keys: {
              verifyEventSignature: (args) => {
                if (args.keyId === 'ed25519:unobtainable') {
                  throw new UpstreamError('transport', {
                    phase: 'key-doc',
                    reason: 'key fetch failed',
                  });
                }
                return keys.verifyEventSignature(args);
              },
            },
          },
        });
        const room = await openRoom(store, fr.roomId);
        await room.tx(async (tx) => {
          if (invalidCreate) {
            assertEquals(
              (await tx.events.getStatus(String(invalidCreate.event_id)))
                ?.standing,
              'rejected',
            );
          } else {
            assertEquals(await tx.events.get(badId), null);
          }
          const before = (await tx.state.eventStateBefore(result.eventId))!;
          const after = (await tx.state.eventStateAfter(result.eventId))!;
          for (const group of [before.group, after.group]) {
            assertEquals(
              await tx.state.groupKey(group, 'm.room.name', ''),
              invalidCreate ? badId : null,
            );
            assertEquals(
              await tx.state.groupKey(group, 'm.room.topic', ''),
              null,
            );
            if (dependent) {
              assertEquals(
                await tx.state.groupKey(group, 'm.room.member', fr.creator),
                null,
              );
            }
          }
          for (const pdu of [dependent, descendant]) {
            if (!pdu) continue;
            assertEquals(
              (await tx.events.getStatus(String(pdu.event_id)))?.standing,
              'rejected',
            );
            assertEquals(
              (await tx.events.getStatus(String(pdu.event_id)))?.grounding,
              'evidence',
            );
          }
          assertEquals(
            await tx.state.groupKey(after.group, 'm.room.member', ANNA),
            result.eventId,
          );
          assertEquals(
            (await tx.events.getStatus(result.eventId))?.standing,
            'accepted',
          );
        });
      });
    });
  }
});

Deno.test('join remote: unusable critical state still refuses the response without a room file', async (t) => {
  const signer = await testSigner();
  const selfKeys = await testRemoteServer();
  for (const type of ['m.room.create', 'm.room.join_rules']) {
    await t.step(type, async () => {
      await withStore(async (store) => {
        const fr = await makeFakeRoom({ roomId: '!critical:remote.test' });
        const { fetcher } = fakeFetcher({
          makeJoin: (user) => fr.makeJoinAnswer(user),
          sendJoin: (event) =>
            fr.acceptSendJoin(event, (resp) => {
              for (const pdu of [...resp.state, ...resp.authChain]) {
                if (pdu.type === type) pdu.signatures = {};
              }
            }),
        });
        const error = await assertRejects(() =>
          joinRemote(store, {
            roomId: fr.roomId,
            user: ANNA,
            via: [fr.server.name],
            signer,
            deps: {
              fetcher,
              self: 'test',
              keys: fakeKeyResolver(fr.server, selfKeys),
            },
          })
        );
        assert(error instanceof MatrixError);
        assertEquals(error.status, 502);
        await assertRejects(() => openRoom(store, fr.roomId));
      });
    });
  }
});
