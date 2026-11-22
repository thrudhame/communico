// tests/federation-invites.test.ts — invites both ways at the engine
// functions (routing is stage 5). Inviter: the /v2/invite request shape
// (stripped list incl. the create with origin_server_ts), merged
// signatures, outbox to room servers, the gate. Invitee: the validation
// matrix, the countersigned response, the federation_invites row.
// Reject: 'rejecting' at once + the intent performing make/send_leave
// against the fake; an unreachable inviter leaves the dance queued (no
// local-only fallback); the second candidate from the stripped state is
// tried. Rescind both ways. (doltgres tests/federation-invites.test.ts,
// restored at the engine functions — /sync rendering is stage 5.)
import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { createFakeRoom, type FakeRoom } from './federation/fake-room.ts';
import {
  acceptRescind,
  type InviteDeps,
  inviteFor,
  inviteIntentProvider,
  inviteRemote,
  markInviteJoined,
  receiveInvite,
  rejectInviteRemote,
  retryPrejoinIntents,
} from '#engine/federation/invites.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startSender } from '#engine/federation/sender.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { finishRoomRemoval } from '#engine/server/removal.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { openStore, type Store } from '#engine/store/index.ts';
import type { Conn } from '#engine/store/db.ts';
import { genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  wireOf,
} from './fixtures/remote.ts';
import { testRemoteServer, testSigner } from './fixtures/signer.ts';
import { assertAuthored } from './fixtures/authored.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { watchdog } from './support/ordering.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

async function ourKeyDoc(name: string): Promise<Record<string, unknown>> {
  const us = await testRemoteServer(name);
  return {
    server_name: name,
    verify_keys: {
      [us.keyId]: {
        key: b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey)),
      },
    },
    old_verify_keys: {},
    valid_until_ts: Date.now() + 86400_000,
    signatures: {},
  };
}

installServerHooks();

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

async function waitFor(
  what: () => Promise<boolean> | boolean,
  ms = 15000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await what()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

// --- INVITER -----------------------------------------------------------------

type InviteHost = {
  fake: FakeServer;
  beforeReply?: () => Promise<void>;
  changeEvent?: (event: Record<string, unknown>) => void;
  response?: () => Response | null;
  inviteRequests: {
    room_version: unknown;
    event: Record<string, unknown>;
    invite_room_state: Record<string, unknown>[];
  }[];
};

async function withInviteHost<T>(
  fn: (h: InviteHost) => Promise<T>,
): Promise<T> {
  setConfigForTests({
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  const h: InviteHost = {
    fake: undefined as unknown as FakeServer,
    inviteRequests: [],
  };
  const ourDoc = await ourKeyDoc('test');
  const handlers = (req: {
    url: URL;
    json(): unknown;
    method: string;
  }): Response | Promise<Response> | null => {
    const path = req.url.pathname;
    if (path.startsWith('/_matrix/federation/v2/invite/')) {
      const body = req.json() as {
        room_version: unknown;
        event: Record<string, unknown>;
        invite_room_state: Record<string, unknown>[];
      };
      // Signing a response may mutate nested signature maps. Retain the actual
      // incoming request, not an object the fake subsequently countersigns.
      h.inviteRequests.push(structuredClone(body));
      // the fake signs the invite as the invitee's server — over the
      // redacted form without the id, like any v3+ signer
      return (async () => {
        await h.beforeReply?.();
        const override = h.response?.();
        if (override) return override;
        h.changeEvent?.(body.event);
        const { redact } = await import('#engine/eventid.ts');
        const redacted = redact(body.event, '11');
        delete redacted.event_id;
        const signedRedacted = await h.fake.sign(redacted);
        const signed = {
          ...body.event,
          signatures: signedRedacted.signatures,
        };
        return Response.json({ event: signed });
      })();
    }
    return null;
  };
  h.fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(ourDoc),
    handlers,
  });
  try {
    return await fn(h);
  } finally {
    await h.fake.close();
    setConfigForTests({ federation: { cacerts: [] } });
    resetCaCertsForTests();
  }
}

Deno.test('inviter: selected scope fences authoring and the durable network intent', async (t) => {
  for (const phase of ['prepare', 'signing', 'intent', 'intent-final']) {
    await t.step(phase, () =>
      withStore(async (store) => {
        await withInviteHost(async (host) => {
          const g = await genesis(store, { roomId: '!invite-admission:test' });
          const server = await store.server();
          let current = phase !== 'prepare', signatures = 0, durable = 0;
          let finalChecks = 0;
          const checkCurrent = () => {
            if (!current) {
              throw new MatrixError(
                503,
                'M_UNAVAILABLE',
                'invite scope retired',
              );
            }
          };
          const deps: InviteDeps = {
            store,
            server,
            self: 'test',
            wake: () => {},
            keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
            signer: {
              ...g.signer,
              async sign(bytes) {
                signatures++;
                const signature = await g.signer.sign(bytes);
                if (phase === 'signing') current = false;
                return signature;
              },
            },
            prepareRoomScope(room, absent, user) {
              assertEquals([room, absent, user], [g.roomId, false, g.creator]);
              checkCurrent();
              return Promise.resolve({
                async check(conn) {
                  assertEquals(
                    (await conn.query(
                      'SELECT COUNT(*) AS n FROM federation_invite_attempts',
                    ))[0].n,
                    0,
                  );
                  durable++;
                  if (phase === 'intent') current = false;
                },
                checkCurrent() {
                  if (
                    phase === 'intent-final' && durable && ++finalChecks === 2
                  ) current = false;
                  checkCurrent();
                },
              });
            },
          };
          await assertRejects(
            () =>
              inviteRemote(
                g.roomId,
                g.creator,
                `@zoe:${host.fake.name}`,
                undefined,
                undefined,
                deps,
              ),
            MatrixError,
            'invite scope retired',
          );
          assertEquals(host.inviteRequests, []);
          assertEquals(signatures, phase === 'prepare' ? 0 : 1);
          assertEquals(durable, phase.startsWith('intent') ? 1 : 0);
          assertEquals(
            await server.query('SELECT * FROM federation_invite_attempts'),
            [],
          );
          const group = await g.room.tx(async (tx) => {
            const stay = await tx.segments.openStay();
            return await tx.state.current(stay!.id);
          });
          assertEquals(
            await g.room.tx((tx) =>
              tx.state.groupKey(
                group!,
                'm.room.member',
                `@zoe:${host.fake.name}`,
              )
            ),
            null,
          );
        });
      }));
  }
});

Deno.test('inviter: retained intent retries before new scope or event signing admission', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (host) => {
      const g = await genesis(store, { roomId: '!retained-admission:test' });
      const server = await store.server();
      let current = true, preparations = 0, durable = 0;
      const checkCurrent = () => {
        if (!current) throw new Error('no new scope');
      };
      const deps: InviteDeps = {
        store,
        server,
        self: 'test',
        signer: g.signer,
        wake: () => {},
        keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
        prepareRoomScope(room, absent, user) {
          assertEquals([room, absent, user], [g.roomId, false, g.creator]);
          preparations++;
          checkCurrent();
          return Promise.resolve({
            checkCurrent,
            async check(conn) {
              await conn.query('SELECT * FROM federation_invite_attempts');
              durable++;
              checkCurrent();
            },
          });
        },
      };
      const call = () =>
        inviteRemote(
          g.roomId,
          g.creator,
          `@zoe:${host.fake.name}`,
          'kept',
          undefined,
          deps,
        );
      host.response = () =>
        Response.json({ errcode: 'M_UNKNOWN', error: 'lost' }, { status: 502 });
      await assertRejects(call);
      assertEquals([preparations, durable], [1, 1]);
      const [attempt] = await server.query(
        'SELECT * FROM federation_invite_attempts',
      );
      assert(attempt);
      current = false;
      deps.signer = {
        ...g.signer,
        prepare: () => Promise.reject(new Error('no new event signing')),
      };
      host.response = () => null;
      assertEquals(await call(), { eventId: String(attempt.event_id) });
      assertEquals([preparations, durable], [1, 1]);
      assertEquals(host.inviteRequests.length, 2);
      assertEquals(host.inviteRequests[1], host.inviteRequests[0]);
      assertEquals(
        await server.query('SELECT * FROM federation_invite_attempts'),
        [],
      );
      assertEquals(
        (await g.room.tx((tx) => tx.events.getStatus(String(attempt.event_id))))
          ?.standing,
        'accepted',
      );
    });
  });
});

Deno.test('inviter: signed attempt survives uncertain response and cold sender recovery', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await withInviteHost(async (h) => {
      const g = await genesis(store, { roomId: '!invite-attempt:test' });
      const target = `@zoe:${h.fake.name}`;
      const depsFor = async (): Promise<InviteDeps> => {
        const server = await store.server();
        return {
          store,
          server,
          signer: g.signer,
          keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
          self: 'test',
          wake: () => {},
        };
      };
      let retained: Record<string, unknown>[] = [];
      h.beforeReply = async () => {
        // Capture the owning DB at the actual network consumer, before any reply.
        try {
          retained = await (await store.server()).query(
            'SELECT * FROM federation_invite_attempts',
          );
        } catch {
          retained = [];
        }
        if (h.inviteRequests.length === 1) {
          await assertRejects(
            () =>
              inviteRemote(
                g.roomId,
                '@dev:test',
                target,
                'kept',
                undefined,
                firstDeps,
              ),
            MatrixError,
            'active',
          );
          await assertRejects(
            () =>
              inviteRemote(
                g.roomId,
                '@dev:test',
                target,
                'changed',
                undefined,
                firstDeps,
              ),
            MatrixError,
            'different',
          );
        }
      };
      h.response = () =>
        Response.json({ errcode: 'M_UNKNOWN', error: 'lost result' }, {
          status: 502,
        });
      const firstDeps = await depsFor();
      await assertRejects(() =>
        inviteRemote(
          g.roomId,
          '@dev:test',
          target,
          'kept',
          undefined,
          firstDeps,
        )
      );
      assertEquals(
        retained.length,
        1,
        'exact signed invite must commit before dispatch',
      );
      const frozen = JSON.parse(String(retained[0].request_json));
      assertEquals(canonicalJson(frozen), canonicalJson(h.inviteRequests[0]));
      assertEquals(
        await g.room.tx((tx) => tx.events.get(String(retained[0].event_id))),
        null,
      );
      const firstWire = canonicalJson(h.inviteRequests[0]);
      await store.close();
      store = await openStore(config(dir), {
        schemas: { room: roomSchema, server: serverSchema },
      });
      const deps = await depsFor();
      const provider = inviteIntentProvider(deps);
      const pending = await provider.review();
      assert(
        pending.some((row) =>
          row.intent.what === 'invite' && row.destination === h.fake.name
        ),
      );
      const job = await provider(deps.server, h.fake.name);
      assert(job, 'cold recovery must use the existing intent owner');
      h.response = () => null;
      // No manual wake: startup discovers the durable invitation even when no
      // ordinary PDU/EDU is queued for this destination.
      const sender = startSender({ store, signer: g.signer });
      sender.setIntentProvider(provider);
      try {
        await waitFor(async () =>
          (await deps.server.query('SELECT * FROM federation_invite_attempts'))
            .length === 0
        );
      } finally {
        await sender.stop();
      }
      assertEquals(h.inviteRequests.length, 2);
      assertEquals(
        canonicalJson(h.inviteRequests[1]),
        firstWire,
        'no timestamp, parents, state or signature rebuild',
      );
      const room = await openRoom(store, g.roomId);
      const stored = await room.tx((tx) =>
        tx.events.get(String(retained[0].event_id))
      );
      assert(stored);
      const event = JSON.parse(stored.pdu);
      assertEquals(event.content.reason, 'kept');
      assert(event.signatures.test);
      assert(event.signatures[h.fake.name]);
      assertEquals(
        await deps.server.query('SELECT * FROM federation_invite_attempts'),
        [],
      );
      assertEquals(await provider(deps.server, h.fake.name), null);
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('inviter: discovered intent reloads a response committed by the live performer', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (h) => {
      const g = await genesis(store, { roomId: '!invite-discovery:test' });
      const server = await store.server();
      const fault = new Error('response committed before local ingest');
      const faultServer = new Proxy(server, {
        get(target, property) {
          if (property === 'execute') {
            return async (...args: Parameters<typeof server.execute>) => {
              const value = await target.execute(...args);
              if (args[0].includes('SET response_json=')) throw fault;
              return value;
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const deps: InviteDeps = {
        store,
        server,
        signer: g.signer,
        keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
        self: 'test',
        wake: () => {},
      };
      const replyReached = Promise.withResolvers<void>();
      const releaseReply = Promise.withResolvers<void>();
      h.beforeReply = () => {
        replyReached.resolve();
        return releaseReply.promise;
      };
      const first = assertRejects(() =>
        inviteRemote(
          g.roomId,
          '@dev:test',
          `@zoe:${h.fake.name}`,
          'retained',
          undefined,
          { ...deps, server: faultServer },
        )
      );
      const provider = inviteIntentProvider(deps);
      try {
        await watchdog(replyReached.promise, 'live invite request dispatch');
        // Discovery normally skips live claims. Capture precisely the durable
        // query result here, then let the live performer finish before the
        // provider examines it. No claim or response is modified by the test.
        const query = server.query.bind(server);
        const staleServer = new Proxy(server, {
          get(target, property) {
            if (property === 'query') {
              return async (...args: Parameters<typeof server.query>) => {
                const rows = await query(...args);
                if (
                  args[0].startsWith('SELECT * FROM federation_invite_attempts')
                ) {
                  releaseReply.resolve();
                  assertEquals(await first, fault);
                }
                return rows;
              };
            }
            const value = Reflect.get(target, property);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const job = await provider(staleServer, h.fake.name);
        assert(job);
        const [retained] = await query(
          'SELECT * FROM federation_invite_attempts',
        );
        assert(retained.response_json !== null);
        await job.run();
        assertEquals(
          h.inviteRequests.length,
          1,
          'saved response must prevent a second PUT',
        );
        assert(
          await g.room.tx((tx) => tx.events.get(String(retained.event_id))),
        );
        assertEquals(
          await query('SELECT * FROM federation_invite_attempts'),
          [],
        );
      } finally {
        releaseReply.resolve();
        await first;
      }
    });
  });
});

Deno.test('inviter: same reference ID cannot hide changed immutable content', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (h) => {
      const g = await genesis(store, { roomId: '!invite-material:test' });
      const server = await store.server();
      h.changeEvent = (event) => {
        (event.content as Record<string, unknown>).reason = 'substituted';
      };
      const deps: InviteDeps = {
        store,
        server,
        signer: g.signer,
        keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
        self: 'test',
        wake: () => {},
      };
      const error = await assertRejects(() =>
        inviteRemote(
          g.roomId,
          '@dev:test',
          `@zoe:${h.fake.name}`,
          'original',
          undefined,
          deps,
        )
      );
      assert(error instanceof UpstreamError);
      assertEquals(error.category, 'validation');
      const request = h.inviteRequests[0];
      const { eventIdFor } = await import('#engine/eventid.ts');
      const id = await eventIdFor(request.event, '11');
      assertEquals(await g.room.tx((tx) => tx.events.get(id)), null);
    });
  });
});

Deno.test('inviter: cold completion after response and ingest cuts never repeats remote work', async (t) => {
  for (const cut of ['response', 'ingest']) {
    await t.step(cut, async () => {
      const dir = await Deno.makeTempDir();
      let store = await openStore(config(dir), {
        schemas: { room: roomSchema, server: serverSchema },
      });
      try {
        await withInviteHost(async (h) => {
          const g = await genesis(store, { roomId: '!invite-cut:test' });
          const server = await store.server();
          const fault = new Error('committed ' + cut + ' cut');
          const faultServer = new Proxy(server, {
            get(target, property) {
              if (property === 'execute') {
                return async (...args: Parameters<typeof server.execute>) => {
                  if (
                    cut === 'ingest' &&
                    args[0].startsWith('DELETE FROM federation_invite_attempts')
                  ) throw fault;
                  const value = await target.execute(...args);
                  if (
                    cut === 'response' && args[0].includes('SET response_json=')
                  ) {
                    throw fault;
                  }
                  return value;
                };
              }
              const value = Reflect.get(target, property);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
          const deps: InviteDeps = {
            store,
            server: faultServer,
            signer: g.signer,
            keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
            self: 'test',
            wake: () => {},
          };
          assertEquals(
            await assertRejects(() =>
              inviteRemote(
                g.roomId,
                '@dev:test',
                `@zoe:${h.fake.name}`,
                'saved',
                undefined,
                deps,
              )
            ),
            fault,
          );
          const rows = await server.query(
            'SELECT * FROM federation_invite_attempts',
          );
          assertEquals(rows.length, 1);
          assert(rows[0].response_json !== null);
          const id = String(rows[0].event_id);
          await store.close();
          store = await openStore(config(dir), {
            schemas: { room: roomSchema, server: serverSchema },
          });
          const nextServer = await store.server();
          const nextDeps = {
            ...deps,
            store,
            server: nextServer,
            keys: productionKeyResolver(
              keyStore(nextServer, { signer: g.signer }),
            ),
          };
          const provider = inviteIntentProvider(nextDeps);
          const job = await provider(nextServer, h.fake.name);
          assert(job);
          await job.run();
          assertEquals(
            h.inviteRequests.length,
            1,
            'retained verified response or room commit completes without network',
          );
          const room = await openRoom(store, g.roomId);
          const stored = await room.tx((tx) => tx.events.get(id));
          assert(stored);
          assertEquals(JSON.parse(stored.pdu).content.reason, 'saved');
          assertEquals(
            await nextServer.query(
              'SELECT membership FROM memberships WHERE room=? AND user=?',
              [g.roomId, `@zoe:${h.fake.name}`],
            ),
            [{ membership: 'invite' }],
          );
          assertEquals(
            await nextServer.query(
              'SELECT count(*) AS n FROM feed WHERE room=? AND event=?',
              [g.roomId, id],
            ),
            [{ n: 1 }],
          );
          assertEquals(
            await nextServer.query('SELECT * FROM federation_invite_attempts'),
            [],
          );
          assertEquals(await provider(nextServer, h.fake.name), null);
        });
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});

Deno.test('inviter: explicit prune and room removal settle retained delivery ownership', async (t) => {
  for (const mode of ['prune', 'remove']) {
    await t.step(mode, async () => {
      await withStore(async (store) => {
        await withInviteHost(async (h) => {
          const g = await genesis(store, { roomId: '!invite-remove:test' });
          const server = await store.server();
          const deps: InviteDeps = {
            store,
            server,
            signer: g.signer,
            keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
            self: 'test',
            wake: () => {},
          };
          h.response = () =>
            Response.json({ errcode: 'M_UNKNOWN', error: 'uncertain result' }, {
              status: 502,
            });
          await assertRejects(() =>
            inviteRemote(
              g.roomId,
              '@dev:test',
              `@zoe:${h.fake.name}`,
              undefined,
              undefined,
              deps,
            )
          );
          const provider = inviteIntentProvider(deps);
          assertEquals((await provider.review()).length, 1);
          if (mode === 'prune') {
            assertEquals(await provider.prune(h.fake.name), 1);
          } else {assertEquals(
              await finishRoomRemoval(store, g.roomId, {
                why: 'explicit removal',
                intents: await provider.review(),
              }, null),
              1,
            );}
          assertEquals(
            await server.query('SELECT * FROM federation_invite_attempts'),
            [],
          );
          assertEquals(await provider(server, h.fake.name), null);
          assertEquals(await provider.review(), []);
        });
      });
    });
  }
});

Deno.test('inviter: unauthorized local membership never becomes remote work', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (h) => {
      const g = await genesis(store, { roomId: '!invite-auth:test' });
      const server = await store.server();
      const deps: InviteDeps = {
        store,
        server,
        signer: g.signer,
        keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
        self: 'test',
        wake: () => {},
      };
      await assertRejects(
        () =>
          inviteRemote(
            g.roomId,
            '@outsider:test',
            `@zoe:${h.fake.name}`,
            undefined,
            undefined,
            deps,
          ),
        MatrixError,
      );
      assertEquals(h.inviteRequests.length, 0);
      assertEquals(
        await server.query('SELECT * FROM federation_invite_attempts'),
        [],
      );
    });
  });
});

Deno.test('inviter: new content replaces only a definitely refused attempt', async (t) => {
  for (
    const outcome of [
      'refusal',
      'uncertain',
      'bad-evidence',
      'timeout',
      'throttle',
      'non-matrix',
    ]
  ) {
    await t.step(outcome, () =>
      withStore(async (store) => {
        await withInviteHost(async (h) => {
          const g = await genesis(store, {
            roomId: '!invite-new-content:test',
          });
          const server = await store.server();
          const deps: InviteDeps = {
            store,
            server,
            signer: g.signer,
            keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
            self: 'test',
            wake: () => {},
          };
          h.response = () => {
            if (outcome === 'bad-evidence') return Response.json({});
            if (outcome === 'non-matrix') {
              return new Response('proxy refused', { status: 403 });
            }
            return Response.json({ errcode: 'M_FORBIDDEN', error: outcome }, {
              status: outcome === 'refusal'
                ? 403
                : outcome === 'timeout'
                ? 408
                : outcome === 'throttle'
                ? 429
                : 502,
            });
          };
          const invite = (reason: string) =>
            inviteRemote(
              g.roomId,
              '@dev:test',
              `@zoe:${h.fake.name}`,
              reason,
              undefined,
              deps,
            );
          await assertRejects(() => invite('A'));
          const [original] = await server.query(
            'SELECT * FROM federation_invite_attempts',
          );
          const request = canonicalJson(h.inviteRequests[0]);
          h.response = () => null;
          if (outcome === 'refusal') {
            deps.prepareRoomScope = () => {
              throw new MatrixError(
                503,
                'M_UNAVAILABLE',
                'fresh scope unavailable',
              );
            };
            const denied = await assertRejects(() => invite('B'), MatrixError);
            assertEquals(denied.status, 503);
            assertEquals(h.inviteRequests.length, 1);
            assertEquals(
              (await server.query(
                'SELECT event_id FROM federation_invite_attempts',
              ))[0].event_id,
              original.event_id,
            );
            delete deps.prepareRoomScope;
            const next = await invite('B');
            assert(next.eventId !== original.event_id);
            assertEquals(
              (h.inviteRequests[1].event.content as Record<string, unknown>)
                .reason,
              'B',
            );
          } else {
            const conflict = await assertRejects(
              () => invite('B'),
              MatrixError,
            );
            assertEquals(conflict.status, 409);
            assertEquals(h.inviteRequests.length, 1);
            assertEquals(
              (await server.query(
                'SELECT request_json FROM federation_invite_attempts',
              ))[0].request_json,
              original.request_json,
            );
            const retry = await invite('A');
            assertEquals(retry.eventId, original.event_id);
            assertEquals(canonicalJson(h.inviteRequests[1]), request);
          }
          assertEquals(
            await server.query('SELECT * FROM federation_invite_attempts'),
            [],
          );
        });
      }));
  }
});

Deno.test('review inviter: upgrade preserves unknown dispatch certainty and fresh attempts start undispatched', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'invite-certainty-upgrade-' });
  let store = await openStore(config(dir), {
    schemas: { server: historicalServerSchema(53) },
  });
  try {
    const old = await store.server();
    for (const status of ['pending', 'refused']) {
      await old.execute(
        'INSERT INTO federation_invite_attempts(room_id,sender,target,event_id,destination,request_json,status,added_ms) VALUES(?,?,?,?,?,?,?,?)',
        [
          '!old:test',
          '@sender:test',
          '@' + status + ':remote.test',
          '$' + status,
          'remote.test',
          '{"frozen":"intent"}',
          status,
          123,
        ],
      );
    }
    await store.close();
    store = await openStore(config(dir), { schemas: { server: serverSchema } });
    const current = await store.server();
    assertEquals(
      await current.query(
        'SELECT request_json,may_have_applied FROM federation_invite_attempts ORDER BY event_id',
      ),
      [
        { request_json: '{"frozen":"intent"}', may_have_applied: 1 },
        { request_json: '{"frozen":"intent"}', may_have_applied: 1 },
      ],
    );
    await current.execute(
      "INSERT INTO federation_invite_attempts(room_id,sender,target,event_id,destination,request_json,status,added_ms) VALUES('!new:test','@sender:test','@new:remote.test','$new','remote.test','{}','pending',123)",
    );
    assertEquals(
      await current.query(
        "SELECT may_have_applied FROM federation_invite_attempts WHERE event_id='$new'",
      ),
      [{ may_have_applied: 0 }],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('review inviter: a later refusal cannot erase an earlier uncertain dispatch across restart', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'invite-certainty-' });
  const schemas = { room: roomSchema, server: serverSchema };
  let store = await openStore(config(dir), { schemas });
  try {
    await withInviteHost(async (h) => {
      const g = await genesis(store, { roomId: '!uncertain-refusal:test' });
      const deps = async (): Promise<InviteDeps> => {
        const server = await store.server();
        return {
          store,
          server,
          signer: g.signer,
          keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
          self: 'test',
          wake() {},
        };
      };
      const invite = async (reason: string) =>
        inviteRemote(
          g.roomId,
          '@dev:test',
          `@zoe:${h.fake.name}`,
          reason,
          undefined,
          await deps(),
        );
      h.response = () =>
        Response.json({
          errcode: 'M_UNKNOWN',
          error: 'response lost after possible acceptance',
        }, { status: 502 });
      await assertRejects(() => invite('A'));
      const original = canonicalJson(h.inviteRequests[0]);
      await store.close();
      store = await openStore(config(dir), { schemas });
      h.response = () =>
        Response.json({
          errcode: 'M_NOT_FOUND',
          error: 'federation temporarily disabled',
        }, { status: 404 });
      await assertRejects(() => invite('A'));
      h.response = () => null;
      const conflict = await assertRejects(() => invite('B'), MatrixError);
      assertEquals(conflict.status, 409);
      assertEquals(h.inviteRequests.length, 2);
      await invite('A');
      assertEquals(canonicalJson(h.inviteRequests[2]), original);
      assertEquals(
        await (await store.server()).query(
          'SELECT * FROM federation_invite_attempts',
        ),
        [],
      );
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('inviter: definite missing-param refusal keeps exact intent for explicit retry', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (h) => {
      const g = await genesis(store, { roomId: '!invite-refusal:test' });
      const server = await store.server();
      const deps: InviteDeps = {
        store,
        server,
        signer: g.signer,
        keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
        self: 'test',
        wake: () => {},
      };
      h.response = () =>
        Response.json({
          errcode: 'M_MISSING_PARAM',
          error: 'missing remote configuration',
        }, { status: 400 });
      const error = await assertRejects(
        () =>
          inviteRemote(
            g.roomId,
            '@dev:test',
            `@zoe:${h.fake.name}`,
            undefined,
            undefined,
            deps,
          ),
        MatrixError,
      );
      assertEquals(error.status, 502);
      const provider = inviteIntentProvider(deps);
      assertEquals(await provider(server, h.fake.name), null);
      assertEquals((await provider.review()).length, 1);
      const before = canonicalJson(h.inviteRequests[0]);
      await retryPrejoinIntents(server, 'test', h.fake.name);
      const job = await provider(server, h.fake.name);
      assert(job);
      h.response = () => null;
      await job.run();
      assertEquals(canonicalJson(h.inviteRequests[1]), before);
      assertEquals(
        await server.query('SELECT * FROM federation_invite_attempts'),
        [],
      );
    });
  });
});

Deno.test('inviter: the /v2/invite shape, merged signatures, outbox to joined servers, the gate', async () => {
  await withStore(async (store) => {
    await withInviteHost(async (h) => {
      const server = await store.server();
      const g = await genesis(store, {
        roomId: '!fed-inv:test',
        joinRule: 'public',
      });
      const dest = h.fake.name;
      // a remote member so the invite's outbox union is non-empty
      const remoteMember = { name: dest, keyId: h.fake.keyId, kp: h.fake.kp };
      const join = await remoteEvent(g.roomId, remoteMember, '11', {
        type: 'm.room.member',
        sender: `@rudy:${dest}`,
        state_key: `@rudy:${dest}`,
        content: { membership: 'join' },
        prev_events: [g.tipId],
        auth_events: await authAt(g.room, {
          type: 'm.room.member',
          sender: `@rudy:${dest}`,
          state_key: `@rudy:${dest}`,
          content: { membership: 'join' },
        }, g.tipId),
        origin_server_ts: 100,
      });
      const joined = await ingestRemote(g.room, [join], dest, {
        keys: fakeKeyResolver(remoteMember),
        fetcher: fakeFetcher({}).fetcher,
        self: g.signer.serverName,
        limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
        ungroundedMs: 3_600_000,
      });
      assertEquals(joined[0].outcome, 'accepted');
      const deps: InviteDeps = {
        store,
        server,
        signer: g.signer,
        keys: productionKeyResolver(keyStore(server, { signer: g.signer })),
        self: g.signer.serverName,
        wake: () => {},
      };
      const zoe = `@zoe:${dest}`;
      const res = await inviteRemote(
        g.roomId,
        '@dev:test',
        zoe,
        undefined,
        undefined,
        deps,
      );
      // the request shape: room_version, event, invite_room_state
      assertEquals(h.inviteRequests.length, 1);
      const req = h.inviteRequests[0];
      assertEquals(req.room_version, '11');
      await assertAuthored(req.event);
      assertEquals(req.event.type, 'm.room.member');
      assertEquals(
        (req.event.content as Record<string, unknown>).membership,
        'invite',
      );
      const stripped = req.invite_room_state;
      const create = stripped.find((e) => e.type === 'm.room.create');
      assert(create !== undefined, 'the create is required');
      assert(
        typeof create.origin_server_ts === 'number',
        'MSC-4311 shape',
      );
      assert(
        stripped.some((e) =>
          e.type === 'm.room.member' && e.state_key === '@dev:test'
        ),
        'the inviter’s member event rides',
      );
      // the merged event ingested with BOTH signatures
      const room = await openRoom(store, g.roomId);
      const stored = await room.tx(async (tx) => {
        const row = await tx.events.get(res.eventId);
        assert(row !== null, 'the merged invite is in the room');
        return (JSON.parse(row.pdu) as Pdu).signatures;
      });
      assert(stored['test'] !== undefined, 'our signature');
      assert(stored[dest] !== undefined, 'the invitee’s signature');
      // outbox rows for the invite go to the room's joined servers (rudy's)
      await waitFor(async () => {
        const rows = await server.query(
          "SELECT event FROM outbox WHERE destination = ? AND state = 'pending'",
          [dest],
        );
        return rows.some((r) => String(r.event) === res.eventId);
      }, 3000);
      // the gate: closed mode → 403, a pending outbound row
      setConfigForTests({ federation: { mode: 'closed' } });
      try {
        let status = 0;
        try {
          await inviteRemote(
            g.roomId,
            '@dev:test',
            '@walt:stranger.test',
            undefined,
            undefined,
            deps,
          );
        } catch (e) {
          status = (e as MatrixError).status;
        }
        assertEquals(status, 403);
        const pending = await server.query(
          "SELECT kind FROM federation_pending WHERE name = 'stranger.test' AND kind = 'outbound'",
          [],
        );
        assertEquals(pending.length, 1, 'the outbound intent is bucketed');
      } finally {
        setConfigForTests({ federation: { mode: 'open' } });
      }
    });
  });
});

// --- INVITEE -----------------------------------------------------------------

async function inviteDepsFor(
  store: Store,
  srv: Awaited<ReturnType<typeof makeRemoteServer>>,
): Promise<InviteDeps> {
  const server = await store.server();
  const signer = await testSigner();
  return {
    store,
    server,
    signer,
    keys: fakeKeyResolver(srv),
    self: 'test',
    wake: () => {},
  };
}

async function remoteInvite(
  srv: Awaited<ReturnType<typeof makeRemoteServer>>,
  roomId: string,
  target: string,
  prev: string[],
): Promise<Pdu> {
  return await remoteEvent(roomId, srv, '11', {
    type: 'm.room.member',
    sender: `@zoe:${srv.name}`,
    state_key: target,
    content: { membership: 'invite' },
    prev_events: prev,
    auth_events: [],
  });
}

Deno.test('invitee: the validation matrix, the countersigned answer, the stored row', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const deps = await inviteDepsFor(store, srv);
    const roomId = '!their-room:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    const eventId = String(invite.event_id);
    const body = {
      room_version: '11',
      event: wireOf(invite),
      invite_room_state: [],
    };
    const attempt = async (
      b: unknown,
      id = eventId,
    ): Promise<number> => {
      try {
        await receiveInvite(roomId, id, b, 'remote.test', deps);
        return 200;
      } catch (e) {
        return (e as MatrixError).status;
      }
    };
    // validation matrix
    assertEquals(await attempt({ ...body, room_version: '99' }), 400);
    assertEquals(
      await attempt({
        ...body,
        event: { ...(body.event as object), type: 'm.room.message' },
      }),
      400,
    );
    assertEquals(
      await attempt({
        ...body,
        event: {
          ...(body.event as object),
          state_key: '@nope:elsewhere.test',
        },
      }),
      400,
    );
    assertEquals(await attempt(body, '$wrong-id'), 400);
    const badSig = JSON.parse(JSON.stringify(body)) as {
      room_version: string;
      event: Record<string, unknown>;
      invite_room_state: unknown[];
    };
    ((badSig.event as Record<string, unknown>).signatures as Record<
      string,
      Record<string, string>
    >)['remote.test'] = { 'ed25519:1': 'AAAA' };
    assertEquals(await attempt(badSig), 403);
    // the good invite
    const good = await receiveInvite(
      roomId,
      eventId,
      body,
      'remote.test',
      deps,
    );
    const answered = good.event as Record<string, unknown>;
    assertEquals('origin' in answered, false);
    assertEquals(answered.hashes, invite.hashes);
    assert(
      (answered.signatures as Record<string, unknown>)['test'] !== undefined,
      'our signature on the answer',
    );
    // the row, stripped state and both signatures kept
    const row = await inviteFor(roomId, '@dev:test', deps);
    assert(row !== null);
    assertEquals(row.status, 'pending');
    assertEquals(row.origin, 'remote.test');
    const storedEvent = JSON.parse(row.eventJson) as Pdu;
    const { signatures: _signatures, ...unchanged } = storedEvent;
    const { signatures: _originalSignatures, ...original } = invite;
    assertEquals(unchanged, original);
    assert(storedEvent.signatures['test'] !== undefined);
    assert(storedEvent.signatures['remote.test'] !== undefined);
    // accepting marks it joined
    await markInviteJoined(roomId, '@dev:test', deps);
    assertEquals(
      (await inviteFor(roomId, '@dev:test', deps))?.status,
      'joined',
    );
  });
});

Deno.test('invitee: a required missing room file cannot become an out-of-band invite', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const original = await inviteDepsFor(store, srv);
    const roomId = '!missing-required:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    const deps = {
      ...original,
      prepareRoomScope: () =>
        Promise.resolve({
          check: () => Promise.resolve(),
          checkCurrent() {},
        }),
    };
    const error = await assertRejects(
      () =>
        receiveInvite(
          roomId,
          String(invite.event_id),
          {
            room_version: '11',
            event: wireOf(invite),
            invite_room_state: [],
          },
          srv.name,
          deps,
        ),
      MatrixError,
    );
    assertEquals(error.status, 503);
    assertEquals(await inviteFor(roomId, '@dev:test', deps), null);
    assertEquals(
      await deps.server.query('SELECT * FROM membership_operations'),
      [],
    );
  });
});

Deno.test('invitee: new work requires selected account and room scope through publication, exact replay does not', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const original = await inviteDepsFor(store, srv);
    const roomId = '!scope-invite:remote.test', target = '@dev:test';
    const invite = await remoteInvite(srv, roomId, target, ['$p1']);
    const eventId = String(invite.event_id);
    const body = {
      room_version: '11',
      event: wireOf(invite),
      invite_room_state: [],
    };
    let current = false, invalidate = false, preparations = 0, checks = 0;
    const checkCurrent = () => {
      if (!current) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'invite scope changed');
      }
    };
    const deps = {
      ...original,
      prepareRoomScope: (room: string, absent?: boolean, user?: string) => {
        if (!absent) {
          return Promise.reject(
            new MatrixError(404, 'M_NOT_FOUND', 'scope not found'),
          );
        }
        assertEquals([room, absent], [roomId, true]);
        assert(user === undefined || user === target);
        preparations++;
        checkCurrent();
        return Promise.resolve({
          checkCurrent,
          check: async (conn: Conn) => {
            assertEquals(
              (await conn.query(
                "SELECT name FROM sqlite_schema WHERE name='membership_operations'",
              )).length,
              1,
            );
            checks++;
            checkCurrent();
          },
        });
      },
      keys: {
        ...original.keys,
        verifyEventSignature: async (
          ...args: Parameters<typeof original.keys.verifyEventSignature>
        ) => {
          const valid = await original.keys.verifyEventSignature(...args);
          if (invalidate) current = false;
          return valid;
        },
      },
    };
    const call = () =>
      receiveInvite(roomId, eventId, structuredClone(body), srv.name, deps);
    await assertRejects(call, MatrixError, 'invite scope changed');
    assertEquals(await inviteFor(roomId, target, deps), null);
    assertEquals(
      await deps.server.query('SELECT * FROM membership_operations'),
      [],
    );
    current = true;
    invalidate = true;
    await assertRejects(call, MatrixError, 'invite scope changed');
    assertEquals(await inviteFor(roomId, target, deps), null);
    assertEquals(
      await deps.server.query('SELECT * FROM membership_operations'),
      [],
    );
    current = true;
    invalidate = false;
    const response = await call();
    assert(preparations >= 3);
    assert(checks > 0);
    assertEquals((await inviteFor(roomId, target, deps))?.eventId, eventId);
    const rows = await deps.server.query('SELECT * FROM membership_operations');
    const counts = await deps.server.query(
      "SELECT * FROM counters WHERE name='events'",
    );
    const prepared = preparations;
    current = false;
    deps.signer = {
      ...deps.signer,
      sign: () => Promise.reject(new Error('no fresh signer')),
    };
    assertEquals(await call(), response);
    assertEquals(preparations, prepared);
    assertEquals(
      await deps.server.query('SELECT * FROM membership_operations'),
      rows,
    );
    assertEquals(
      await deps.server.query("SELECT * FROM counters WHERE name='events'"),
      counts,
    );
  });
});

Deno.test('invitee: cold replay retains its signed response without resurrecting superseded OOB state', async () => {
  const dir = await Deno.makeTempDir();
  let store = await openStore(config(dir), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    const srv = await makeRemoteServer('remote.test');
    let deps = await inviteDepsFor(store, srv);
    const roomId = '!retained-invite:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    const eventId = String(invite.event_id);
    const body = {
      room_version: '11',
      event: wireOf(invite),
      invite_room_state: [],
    };
    const result = await receiveInvite(
      roomId,
      eventId,
      structuredClone(body),
      srv.name,
      deps,
    );
    await rejectInviteRemote(roomId, '@dev:test', deps);
    const rejected = await inviteFor(roomId, '@dev:test', deps);
    assertEquals(
      await receiveInvite(
        roomId,
        eventId,
        structuredClone(body),
        srv.name,
        deps,
      ),
      result,
    );
    assertEquals(await inviteFor(roomId, '@dev:test', deps), rejected);
    const next = await remoteInvite(srv, roomId, '@dev:test', ['$p2']);
    await receiveInvite(
      roomId,
      String(next.event_id),
      {
        ...body,
        event: wireOf(next),
      },
      srv.name,
      deps,
    );
    const before = await inviteFor(roomId, '@dev:test', deps);
    const counts = await deps.server.query(
      "SELECT * FROM counters WHERE name='events'",
    );
    await store.close();
    store = await openStore(config(dir), {
      schemas: { room: roomSchema, server: serverSchema },
    });
    deps = await inviteDepsFor(store, srv);
    deps.prepareRoomScope = () =>
      Promise.reject(
        new MatrixError(503, 'M_UNAVAILABLE', 'scope no longer served'),
      );
    deps.signer = {
      ...deps.signer,
      sign: () =>
        Promise.reject(new Error('new signing authority unavailable')),
    };
    assertEquals(
      await receiveInvite(
        roomId,
        eventId,
        structuredClone(body),
        srv.name,
        deps,
      ),
      result,
    );
    assertEquals(await inviteFor(roomId, '@dev:test', deps), before);
    assertEquals(
      await deps.server.query("SELECT * FROM counters WHERE name='events'"),
      counts,
    );
    const invalid = structuredClone(body);
    invalid.event.signatures = { [srv.name]: { 'ed25519:1': 'AAAA' } };
    await assertRejects(
      () => receiveInvite(roomId, eventId, invalid, srv.name, deps),
      MatrixError,
      'bad signature',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('invitee: held-room response survives ACL change and explicit room removal without OOB publication', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!held-invite:test' });
    const srv = await makeRemoteServer('remote.test');
    const deps = await inviteDepsFor(store, srv);
    const invite = await remoteInvite(srv, g.roomId, '@other:test', ['$p1']);
    const eventId = String(invite.event_id);
    const body = {
      room_version: '11',
      event: wireOf(invite),
      invite_room_state: [],
    };
    const result = await receiveInvite(
      g.roomId,
      eventId,
      structuredClone(body),
      srv.name,
      deps,
    );
    assertEquals(await inviteFor(g.roomId, '@other:test', deps), null);
    await sendLocal(g.room, {
      type: 'm.room.server_acl',
      state_key: '',
      sender: g.creator,
      content: { allow: ['*'], deny: [srv.name] },
      origin_server_ts: Date.now(),
    }, g.signer);
    deps.signer = {
      ...deps.signer,
      sign: () => Promise.reject(new Error('no new authority')),
    };
    assertEquals(
      await receiveInvite(
        g.roomId,
        eventId,
        structuredClone(body),
        srv.name,
        deps,
      ),
      result,
    );
    const fresh = await remoteInvite(srv, g.roomId, '@other:test', ['$p2']);
    const denied = await assertRejects(
      () =>
        receiveInvite(
          g.roomId,
          String(fresh.event_id),
          {
            ...body,
            event: wireOf(fresh),
          },
          srv.name,
          deps,
        ),
      MatrixError,
    );
    assertEquals(denied.status, 403);
    await finishRoomRemoval(store, g.roomId, {
      why: 'explicit retirement',
      intents: [],
    }, null);
    assertEquals(
      await receiveInvite(
        g.roomId,
        eventId,
        structuredClone(body),
        srv.name,
        deps,
      ),
      result,
    );
    assertEquals(await store.rooms(), []);
    assertEquals(await inviteFor(g.roomId, '@other:test', deps), null);
    assertEquals(
      (await deps.server.query('SELECT * FROM membership_operations')).length,
      1,
    );
  });
});

Deno.test('invitee: response and OOB transition recover atomically at transaction cuts', async (t) => {
  for (const cut of ['before-commit', 'after-commit']) {
    await t.step(cut, async () => {
      const dir = await Deno.makeTempDir();
      let store = await openStore(config(dir), {
        schemas: { room: roomSchema, server: serverSchema },
      });
      try {
        const srv = await makeRemoteServer('remote.test');
        const deps = await inviteDepsFor(store, srv);
        const roomId = '!atomic-invite:remote.test';
        const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
        const eventId = String(invite.event_id);
        const body = {
          room_version: '11',
          event: wireOf(invite),
          invite_room_state: [],
        };
        const fault = new Error(cut);
        const server = deps.server;
        deps.server = {
          ...server,
          tx: async (fn, options) => {
            let wrote = false;
            const result = await server.tx((tx) =>
              fn(
                new Proxy(tx, {
                  get(target, key) {
                    if (key === 'execute') {
                      return async (...args: Parameters<Conn['execute']>) => {
                        const result = await target.execute(...args);
                        if (
                          args[0].startsWith(
                            'INSERT INTO membership_operations',
                          )
                        ) {
                          wrote = true;
                          if (cut === 'before-commit') throw fault;
                        }
                        return result;
                      };
                    }
                    const value = Reflect.get(target, key);
                    return typeof value === 'function'
                      ? value.bind(target)
                      : value;
                  },
                }),
              ), options);
            if (wrote && cut === 'after-commit') throw fault;
            return result;
          },
        };
        assertEquals(
          await assertRejects(() =>
            receiveInvite(
              roomId,
              eventId,
              structuredClone(body),
              srv.name,
              deps,
            )
          ),
          fault,
        );
        await store.close();
        store = await openStore(config(dir), {
          schemas: { room: roomSchema, server: serverSchema },
        });
        const cold = await inviteDepsFor(store, srv);
        assertEquals(
          await store.rooms(),
          [],
          'OOB invite never provisions a room',
        );
        const receipts = await cold.server.query(
          'SELECT * FROM membership_operations',
        );
        const pending = await inviteFor(roomId, '@dev:test', cold);
        if (cut === 'before-commit') {
          assertEquals(receipts, []);
          assertEquals(pending, null);
          assertEquals(
            await cold.server.query(
              "SELECT * FROM counters WHERE name='events'",
            ),
            [],
          );
        } else {
          assertEquals(receipts.length, 1);
          assert(pending !== null);
          assertEquals(pending.seq, 1);
          cold.signer = {
            ...cold.signer,
            sign: () => Promise.reject(new Error('signer unavailable')),
          };
        }
        const result = await receiveInvite(
          roomId,
          eventId,
          structuredClone(body),
          srv.name,
          cold,
        );
        assertEquals(
          await cold.server.query(
            "SELECT value FROM counters WHERE name='events'",
          ),
          [{ value: 1 }],
        );
        assertEquals(
          (await cold.server.query('SELECT * FROM membership_operations'))
            .length,
          1,
        );
        assertEquals(
          (await inviteFor(roomId, '@dev:test', cold))?.eventId,
          eventId,
        );
        if (cut === 'after-commit') {
          assertEquals(result, JSON.parse(String(receipts[0].result_json)));
        }
      } finally {
        await store.close();
        await Deno.remove(dir, { recursive: true });
      }
    });
  }
});

Deno.test('invitee: same reference ID cannot replace retained immutable material', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const deps = await inviteDepsFor(store, srv);
    const roomId = '!invite-collision:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    const eventId = String(invite.event_id);
    const body = {
      room_version: '11',
      event: wireOf(invite),
      invite_room_state: [],
    };
    const response = await receiveInvite(
      roomId,
      eventId,
      structuredClone(body),
      srv.name,
      deps,
    );
    const before = await inviteFor(roomId, '@dev:test', deps);
    const changed = structuredClone(body);
    (changed.event.content as Record<string, unknown>).reason =
      'changed without changing reference ID';
    const error = await assertRejects(
      () => receiveInvite(roomId, eventId, changed, srv.name, deps),
      MatrixError,
    );
    assertEquals(error.status, 400);
    assertEquals(error.errcode, 'M_BAD_JSON');
    assertEquals(
      await receiveInvite(
        roomId,
        eventId,
        structuredClone(body),
        srv.name,
        deps,
      ),
      response,
    );
    assertEquals(await inviteFor(roomId, '@dev:test', deps), before);
  });
});

// --- REJECT ------------------------------------------------------------------

Deno.test('reject: selected scope fences new departures, never retained retry ownership', async (t) => {
  for (
    const phase of ['prepare', 'signing', 'intent', 'intent-final', 'retry']
  ) {
    await t.step(phase, () =>
      withStore(async (store) => {
        const remote = await makeRemoteServer('remote.test');
        const original = await inviteDepsFor(store, remote);
        const roomId = '!reject-admission:remote.test', userId = '@dev:test';
        const invite = await remoteInvite(remote, roomId, userId, ['$parent']);
        await receiveInvite(
          roomId,
          String(invite.event_id),
          {
            room_version: '11',
            event: wireOf(invite),
            invite_room_state: [],
          },
          remote.name,
          original,
        );
        const capture = async () => ({
          display: await original.server.query(
            'SELECT * FROM prejoin_memberships',
          ),
          jobs: await original.server.query('SELECT * FROM prejoin_jobs'),
          facts: await original.server.query(
            'SELECT * FROM membership_operations',
          ),
          counters: await original.server.query('SELECT * FROM counters'),
        });
        const before = await capture();
        let current = phase !== 'prepare', signatures = 0, durable = 0;
        let preparations = 0, finalChecks = 0;
        const checkCurrent = () => {
          if (!current) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'departure scope retired',
            );
          }
        };
        const deps: InviteDeps = {
          ...original,
          signer: {
            ...original.signer,
            async sign(bytes) {
              signatures++;
              const signature = await original.signer.sign(bytes);
              if (phase === 'signing') current = false;
              return signature;
            },
          },
          prepareRoomScope(room, absent, user) {
            assertEquals([room, absent, user], [roomId, true, userId]);
            preparations++;
            checkCurrent();
            return Promise.resolve({
              async check(conn) {
                assertEquals(
                  (await conn.query('SELECT status FROM prejoin_memberships'))[
                    0
                  ].status,
                  'pending',
                );
                durable++;
                if (phase === 'intent') current = false;
              },
              checkCurrent() {
                if (phase === 'intent-final' && ++finalChecks === 2) {
                  current = false;
                }
                checkCurrent();
              },
            });
          },
        };
        const call = () => rejectInviteRemote(roomId, userId, deps, 'kept');
        if (phase !== 'retry') {
          await assertRejects(call, MatrixError, 'departure scope retired');
          assertEquals(
            await capture(),
            before,
            'no display, fact, job or stream publication on refusal',
          );
          assertEquals(
            signatures,
            ['prepare', 'intent'].includes(phase) ? 0 : 1,
          );
          return;
        }
        await call();
        assertEquals(preparations, 1);
        assertEquals(durable, 1);
        assertEquals(signatures, 1);
        const retained = await capture();
        assertEquals(retained.display[0].status, 'rejecting');
        assertEquals(
          JSON.parse(String(retained.display[0].local_leave_json)).content
            .reason,
          'kept',
        );
        current = false;
        deps.signer = {
          ...deps.signer,
          sign: () => Promise.reject(new Error('no new signature')),
        };
        for (const status of ['rejecting', 'rejected', 'failed-retract']) {
          await deps.server.execute('UPDATE prejoin_memberships SET status=?', [
            status,
          ]);
          const expected = await capture();
          await call();
          assertEquals(await capture(), expected);
        }
        assertEquals(preparations, 1);
        assertEquals(signatures, 1);
      }));
  }
});

Deno.test('reject: local effect at once + the intent performs make/send_leave against the fake', async () => {
  await withStore(async (store) => {
    setConfigForTests({
      federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    resetCaCertsForTests();
    try {
      const server = await store.server();
      const h = {
        fake: undefined as unknown as FakeServer,
        room: undefined as unknown as FakeRoom,
        makeLeaveCalls: [] as string[],
        sendLeaveCalls: [] as Record<string, unknown>[],
      };
      const ourDoc = await ourKeyDoc('test');
      const handlers = (req: {
        url: URL;
        json(): unknown;
        method: string;
      }): Response | null => {
        const path = req.url.pathname;
        if (path.startsWith('/_matrix/federation/v1/make_leave/')) {
          const userId = decodeURIComponent(path.split('/').pop()!);
          h.makeLeaveCalls.push(userId);
          return Response.json(h.room.makeLeaveTemplate(userId));
        }
        if (path.startsWith('/_matrix/federation/v2/send_leave/')) {
          h.sendLeaveCalls.push(req.json() as Record<string, unknown>);
          return Response.json({});
        }
        return null;
      };
      h.fake = await startFakeServer({
        ourKeyDoc: () => Promise.resolve(ourDoc),
        handlers,
      });
      try {
        h.room = await createFakeRoom({
          version: '11',
          creator: `@zoe:${h.fake.name}`,
          server: {
            name: h.fake.name,
            keyId: h.fake.keyId,
            kp: h.fake.kp,
          },
        });
        // the fake invites our dev into its room
        const inviteEvent = await h.room.addEvent({
          type: 'm.room.member',
          sender: `@zoe:${h.fake.name}`,
          state_key: '@dev:test',
          content: { membership: 'invite' },
        });
        const remoteMember = {
          name: h.fake.name,
          keyId: h.fake.keyId,
          kp: h.fake.kp,
        };
        const signer = await testSigner();
        const sender = startSender({ store, signer });
        const deps: InviteDeps = {
          store,
          server,
          signer,
          keys: fakeKeyResolver(remoteMember),
          self: 'test',
          wake: (d) => sender.wake(d),
        };
        sender.setIntentProvider(inviteIntentProvider(deps));
        try {
          const received = await receiveInvite(
            h.room.roomId,
            String(inviteEvent.event_id),
            {
              room_version: '11',
              event: h.room.wire(inviteEvent),
              invite_room_state: [],
            },
            h.fake.name,
            deps,
          );
          assert(
            (received.event as Record<string, unknown>).signatures !==
              undefined,
          );
          // reject: the row goes 'rejecting' at once
          await rejectInviteRemote(h.room.roomId, '@dev:test', deps);
          assertEquals(
            (await inviteFor(h.room.roomId, '@dev:test', deps))?.status,
            'rejecting',
          );
          // the intent performs make_leave + send_leave against the fake
          await waitFor(() => h.sendLeaveCalls.length >= 1, 10000);
          // Receipt precedes the response and the sender's durable completion.
          await waitFor(
            async () =>
              (await inviteFor(h.room.roomId, '@dev:test', deps))?.status ===
                'rejected',
            10000,
          );
          assert(h.makeLeaveCalls.includes('@dev:test'));
          await assertAuthored(h.sendLeaveCalls[0]);
          assertEquals(
            (await inviteFor(h.room.roomId, '@dev:test', deps))?.status,
            'rejected',
          );
          // the signed leave is what stage 5 renders
          const rendered = JSON.parse(
            (await inviteFor(h.room.roomId, '@dev:test', deps))!.eventJson,
          ) as Record<string, unknown>;
          assertEquals(rendered.type, 'm.room.member');
          await assertAuthored(rendered);
          assertEquals(
            (rendered.content as Record<string, unknown>).membership,
            'leave',
          );
          assert(
            (rendered.signatures as Record<string, unknown>)['test'] !==
              undefined,
            'our signature on the leave',
          );
          // the intent row is spent — nothing left for the fake
          assertEquals(
            (await server.query(
              "SELECT 1 FROM prejoin_memberships WHERE status = 'rejecting'",
              [],
            )).length,
            0,
          );
        } finally {
          await sender.stop();
        }
      } finally {
        await h.fake.close();
      }
    } finally {
      setConfigForTests({ federation: { cacerts: [] } });
      resetCaCertsForTests();
    }
  });
});

Deno.test('reject: an unreachable inviter leaves the dance queued; the second candidate is tried', async () => {
  await withStore(async (store) => {
    setConfigForTests({
      federation: {
        cacerts: ['tests/fixtures/tls/ca.crt'],
        connectms: 1000,
        timeoutms: 3000,
        backoffstartmillihours: 1,
      },
    });
    resetCaCertsForTests();
    try {
      const server = await store.server();
      const dead = await makeRemoteServer('dead.test');
      // the fake is only the SECOND candidate (a server named in the
      // stripped state)
      const sendLeaveCalls: string[] = [];
      const ourDoc = await ourKeyDoc('test');
      let room: FakeRoom;
      const fake = await startFakeServer({
        ourKeyDoc: () => Promise.resolve(ourDoc),
        handlers: (req) => {
          const path = req.url.pathname;
          if (path.startsWith('/_matrix/federation/v1/make_leave/')) {
            const userId = decodeURIComponent(path.split('/').pop()!);
            return Response.json(room.makeLeaveTemplate(userId));
          }
          if (path.startsWith('/_matrix/federation/v2/send_leave/')) {
            sendLeaveCalls.push('called');
            return Response.json({});
          }
          return null;
        },
      });
      try {
        room = await createFakeRoom({
          version: '11',
          creator: `@zoe:${fake.name}`,
          server: { name: fake.name, keyId: fake.keyId, kp: fake.kp },
        });
        await room.addEvent({
          type: 'm.room.member',
          sender: `@zoe:${dead.name}`,
          state_key: '@dev:test',
          content: { membership: 'invite' },
        });
        // signed by the unreachable inviter
        const signed = await remoteEvent(
          room.roomId,
          dead,
          '11',
          {
            type: 'm.room.member',
            sender: `@zoe:${dead.name}`,
            state_key: '@dev:test',
            content: { membership: 'invite' },
            prev_events: room.extremityIds(),
            auth_events: [],
          },
        );
        const signer = await testSigner();
        const sender = startSender({ store, signer });
        const deps: InviteDeps = {
          store,
          server,
          signer,
          keys: fakeKeyResolver(dead),
          self: 'test',
          wake: (d) => sender.wake(d),
        };
        sender.setIntentProvider(inviteIntentProvider(deps));
        try {
          await receiveInvite(
            room.roomId,
            String(signed.event_id),
            {
              room_version: '11',
              event: wireOf(signed),
              invite_room_state: [
                {
                  type: 'm.room.member',
                  state_key: `@zoe:${fake.name}`,
                  content: { membership: 'join' },
                  sender: `@zoe:${fake.name}`,
                },
              ],
            },
            dead.name,
            deps,
          );
          await rejectInviteRemote(room.roomId, '@dev:test', deps);
          // dead.test fails; the dance does NOT fall back to local-only —
          // the second candidate (from the stripped state) performs it
          await waitFor(() => sendLeaveCalls.length >= 1, 20000);
          await waitFor(
            async () =>
              (await inviteFor(room.roomId, '@dev:test', deps))?.status ===
                'rejected',
            20000,
          );
          assertEquals(
            (await inviteFor(room.roomId, '@dev:test', deps))?.status,
            'rejected',
          );
        } finally {
          await sender.stop();
        }
      } finally {
        await fake.close();
      }
    } finally {
      setConfigForTests({
        federation: {
          cacerts: [],
          connectms: 5000,
          timeoutms: 30000,
          backoffstartmillihours: 125,
        },
      });
      resetCaCertsForTests();
    }
  });
});

// --- RESCIND ------------------------------------------------------------------

Deno.test('rescind: the inviter’s leave rejects the out-of-band invite; a third party’s does not', async () => {
  await withStore(async (store) => {
    const srv = await makeRemoteServer('remote.test');
    const deps = await inviteDepsFor(store, srv);
    const roomId = '!rescind:remote.test';
    const invite = await remoteInvite(srv, roomId, '@dev:test', ['$p1']);
    await receiveInvite(
      roomId,
      String(invite.event_id),
      { room_version: '11', event: wireOf(invite), invite_room_state: [] },
      'remote.test',
      deps,
    );
    // a third party's kick is honored by nobody
    const kick = await remoteEvent(roomId, srv, '11', {
      type: 'm.room.member',
      sender: `@rudy:${srv.name}`,
      state_key: '@dev:test',
      content: { membership: 'leave' },
      prev_events: ['$p2'],
      auth_events: [],
    });
    assertEquals(await acceptRescind(roomId, kick, deps), false);
    assertEquals(
      (await inviteFor(roomId, '@dev:test', deps))?.status,
      'pending',
    );
    // the inviter's own leave rescinds
    const rescind = await remoteEvent(roomId, srv, '11', {
      type: 'm.room.member',
      sender: `@zoe:${srv.name}`,
      state_key: '@dev:test',
      content: { membership: 'leave' },
      prev_events: ['$p3'],
      auth_events: [],
    });
    assertEquals(await acceptRescind(roomId, rescind, deps), true);
    const row = await inviteFor(roomId, '@dev:test', deps);
    assertEquals(row?.status, 'rejected');
    const rendered = JSON.parse(row!.eventJson) as Record<string, unknown>;
    assertEquals(
      (rendered.content as Record<string, unknown>).membership,
      'leave',
    );
  });
});
