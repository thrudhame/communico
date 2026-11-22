import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { type InviteDeps, inviteFor } from '#engine/federation/invites.ts';
import { knockRemote, performKnockAttempt } from '#engine/federation/knocks.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { createFakeRoom, type FakeRoom } from '#tests/federation/fake-room.ts';
import { fakeKeyResolver } from '#tests/fixtures/remote.ts';
import { testRemoteServer, testSigner } from '#tests/fixtures/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';

Deno.test('knock: selected scope fences template use and the durable attempt, not retained execution', async (t) => {
  for (
    const phase of [
      'prepare',
      'response',
      'signing',
      'intent',
      'intent-final',
      'retry',
    ]
  ) {
    await t.step(phase, async () => {
      const dir = await Deno.makeTempDir();
      const store = await openStore({
        dir,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { room: roomSchema, server: serverSchema } });
      setConfigForTests({
        federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
      });
      resetCaCertsForTests();
      let room: FakeRoom;
      let current = phase !== 'prepare', preparations = 0, durable = 0;
      let makes = 0, signatures = 0, finalChecks = 0;
      const sent: unknown[] = [];
      let lost = phase === 'retry';
      const ours = await testRemoteServer();
      const doc = {
        server_name: ours.name,
        verify_keys: {
          [ours.keyId]: {
            key: b64encodeStd(await exportPublicKeyRaw(ours.kp.publicKey)),
          },
        },
        old_verify_keys: {},
        valid_until_ts: Date.now() + 86400_000,
        signatures: {},
      };
      const fake = await startFakeServer({
        ourKeyDoc: () => Promise.resolve(doc),
        handlers(req) {
          if (
            req.url.pathname.startsWith('/_matrix/federation/v1/make_knock/')
          ) {
            makes++;
            const template = room.makeJoinTemplate('@dev:test');
            (template.event as { content: unknown }).content = {
              membership: 'knock',
            };
            if (phase === 'response') current = false;
            return Response.json(template);
          }
          if (
            req.url.pathname.startsWith('/_matrix/federation/v1/send_knock/')
          ) {
            sent.push(req.json());
            if (lost) {
              return Response.json({ errcode: 'M_UNKNOWN', error: 'lost' }, {
                status: 502,
              });
            }
            return Response.json({
              knock_room_state: room.currentState().map(room.wire),
            });
          }
          return null;
        },
      });
      try {
        const remote = { name: fake.name, kp: fake.kp, keyId: fake.keyId };
        room = await createFakeRoom({
          version: '11',
          creator: '@owner:' + fake.name,
          server: remote,
        });
        const signer = await testSigner();
        const server = await store.server();
        const checkCurrent = () => {
          if (!current) {
            throw new MatrixError(503, 'M_UNAVAILABLE', 'knock scope retired');
          }
        };
        const deps: InviteDeps = {
          store,
          server,
          self: 'test',
          keys: fakeKeyResolver(remote),
          wake: () => {},
          signer: {
            ...signer,
            async sign(bytes) {
              const result = await signer.sign(bytes);
              if (JSON.parse(bytes).type === 'm.room.member') {
                signatures++;
                if (phase === 'signing') current = false;
              }
              return result;
            },
          },
          prepareRoomScope(roomId, absent, user) {
            assertEquals([roomId, absent, user], [
              room.roomId,
              true,
              '@dev:test',
            ]);
            preparations++;
            checkCurrent();
            return Promise.resolve({
              async check(conn) {
                assertEquals(
                  await conn.query('SELECT * FROM prejoin_memberships'),
                  [],
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
        const call = () =>
          knockRemote(
            room.roomId,
            '@dev:test',
            { reason: 'kept' },
            [fake.name],
            deps,
          );
        if (phase !== 'retry') {
          await assertRejects(call, MatrixError, 'knock scope retired');
          assertEquals(makes, phase === 'prepare' ? 0 : 1);
          assertEquals(
            signatures,
            ['prepare', 'response'].includes(phase) ? 0 : 1,
          );
          assertEquals(durable, phase.startsWith('intent') ? 1 : 0);
          assertEquals(sent, []);
          for (
            const table of [
              'prejoin_memberships',
              'prejoin_jobs',
              'membership_operations',
            ]
          ) {
            assertEquals(await server.query('SELECT * FROM ' + table), []);
          }
          assertEquals(
            await server.query("SELECT * FROM counters WHERE name='events'"),
            [],
          );
          return;
        }
        await assertRejects(call);
        assertEquals([preparations, durable, makes, signatures, sent.length], [
          1,
          1,
          1,
          1,
          1,
        ]);
        const attempt = await inviteFor(room.roomId, '@dev:test', deps);
        assert(attempt);
        assertEquals(attempt.status, 'attempting');
        current = false;
        lost = false;
        assertEquals(await performKnockAttempt(attempt, deps), true);
        assertEquals([preparations, durable, makes, signatures, sent.length], [
          1,
          1,
          1,
          1,
          2,
        ]);
        assertEquals(sent[1], sent[0]);
        const pending = await inviteFor(room.roomId, '@dev:test', deps);
        assertEquals([pending?.eventId, pending?.status], [
          attempt.eventId,
          'pending',
        ]);
        assertEquals(await performKnockAttempt(attempt, deps), true);
        assertEquals(sent.length, 2);
      } finally {
        await fake.close();
        await store.close();
        await Deno.remove(dir, { recursive: true });
        setConfigForTests({ federation: { cacerts: [] } });
        resetCaCertsForTests();
      }
    });
  }
});
