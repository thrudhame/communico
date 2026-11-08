import { assert, assertEquals, assertRejects } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { closeApp, openApp, startFederationServices } from '#engine/app.ts';
import { startHttp } from './http-app.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { type FakeRoom, makeFakeRoom } from './fixtures/remote-room.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom } from '#engine/room/index.ts';
import { receiveInvite } from '#engine/federation/invites.ts';
import { inviteDeps } from '#engine/client/write.ts';
import {
  beginJoinAttempt,
  pendingJoinAttempts,
  releaseJoinAttempt,
} from '#engine/server/join-attempts.ts';

const strict = () =>
  setConfigForTests({
    server: { name: 'test' },
    encryption: {
      allowunencryptedcreation: false,
      allowunencryptedjoining: false,
      allowunencryptedmessages: false,
    },
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });

Deno.test('HTTP E6 confirmed send_join refusals allow retry and failover without compensating a nonexistent join', async () => {
  const old = config();
  strict();
  const http = await startHttp();
  let room: FakeRoom;
  let refusal = 403;
  let legacy = 'none';
  const ourKeyDoc = () =>
    Promise.resolve({
      server_name: 'test',
      verify_keys: {
        [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
      },
    });
  const fake = await startFakeServer({
    ourKeyDoc,
    handlers: (req) => {
      if (req.path.includes('/make_join/')) {
        const user = decodeURIComponent(req.url.pathname.split('/').at(-1)!);
        return Response.json({
          room_version: room.version,
          event: room.makeJoinAnswer(user).event,
        });
      }
      if (req.path.includes('/send_join/')) {
        assert(req.verified);
        if (legacy !== 'none' && req.path.includes('/v2/')) {
          return legacy === 'matrix'
            ? Response.json({ errcode: 'M_UNRECOGNIZED' }, { status: 404 })
            : new Response('not found', { status: 404 });
        }
        return Response.json({
          errcode: refusal === 404 ? 'M_NOT_FOUND' : 'M_FORBIDDEN',
        }, { status: refusal });
      }
      if (req.path.includes('/make_leave/')) {
        return Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 });
      }
      return null;
    },
  });
  const resident = await startFakeServer({
    ourKeyDoc,
    handlers: (req) => {
      if (req.path.includes('/make_join/')) {
        const user = decodeURIComponent(req.url.pathname.split('/').at(-1)!);
        return Response.json({
          room_version: room.version,
          event: room.makeJoinAnswer(user).event,
        });
      }
      if (req.path.includes('/send_join/')) {
        return (async () => {
          assert(req.verified);
          const response = await room.acceptSendJoin({
            ...(req.json() as Pdu),
            event_id: decodeURIComponent(req.url.pathname.split('/').at(-1)!),
          });
          return Response.json({
            state: response.state,
            auth_chain: response.authChain,
            event: response.event,
          });
        })();
      }
      return null;
    },
  });
  try {
    const user = await http.registerTestUser('join-refusal', 'pw');
    const join = (via: string[]) =>
      http.matrix(
        new Request(
          'http://x/_matrix/client/v3/join/' + encodeURIComponent(room.roomId) +
            '?' +
            new URLSearchParams(via.map((name) => ['server_name', name])),
          {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + user.access_token },
            body: '{}',
          },
        ),
      );
    for (const v1 of ['none', 'matrix', 'html']) {
      legacy = v1;
      refusal = 403;
      room = await makeFakeRoom({
        roomId: '!refused-' + v1 + ':' + resident.name,
        server: resident,
      });
      await room.addEvent({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
      let response = await join([fake.name]);
      assertEquals(response.status, 403, await response.text());
      assertEquals(
        await pendingJoinAttempts(http.app.server),
        [],
        'a confirmed refusal must not strand join admission',
      );
      response = await join([resident.name]);
      assertEquals(response.status, 200, await response.text());
      assertEquals(await pendingJoinAttempts(http.app.server), []);
      refusal = 404;
      room = await makeFakeRoom({
        roomId: '!failover-' + v1 + ':' + resident.name,
        server: resident,
      });
      await room.addEvent({
        type: 'm.room.encryption',
        state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      });
      response = await join([fake.name, resident.name]);
      assertEquals(response.status, 200, await response.text());
      assertEquals(await pendingJoinAttempts(http.app.server), []);
    }
    assertEquals(
      fake.requests.filter((req) => req.path.includes('/make_leave/')).length,
      0,
    );
  } finally {
    await http.close();
    await fake.close();
    await resident.close();
    setConfigForTests(old);
  }
});

Deno.test('HTTP E6 unknown joins, aliases, invite acceptance and authoritative encryption races compensate through production transport', async () => {
  const old = config();
  strict();
  const http = await startHttp();
  const signer = http.app.tenant.signer();
  let room: FakeRoom;
  let remoteMembership = 'leave';
  let stripEncryption = false;
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: 'test',
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (req.path.includes('/query/directory')) {
        return Response.json({ room_id: room.roomId, servers: [fake.name] });
      }
      if (
        req.path.includes('/make_join/') || req.path.includes('/make_leave/')
      ) {
        const user = decodeURIComponent(req.url.pathname.split('/').at(-1)!);
        return Response.json({
          room_version: '11',
          event: room.makeJoinAnswer(user).event,
        });
      }
      if (req.path.includes('/send_join/')) {
        return (async () => {
          assert(req.verified);
          const pdu = {
            ...(req.json() as Pdu),
            event_id: decodeURIComponent(req.url.pathname.split('/').at(-1)!),
          };
          const response = await room.acceptSendJoin(pdu);
          remoteMembership = 'join';
          if (stripEncryption) {
            response.state = response.state.filter((event) =>
              event.type !== 'm.room.encryption'
            );
          }
          return Response.json({
            state: response.state,
            auth_chain: response.authChain,
            event: response.event,
          });
        })();
      }
      if (req.path.includes('/send_leave/')) {
        assert(req.verified);
        assertEquals((req.json() as Pdu).content.membership, 'leave');
        remoteMembership = 'leave';
        return Response.json({});
      }
      return null;
    },
  });
  try {
    const user = await http.registerTestUser('join-policy', 'pw');
    const remote = { name: fake.name, keyId: fake.keyId, kp: fake.kp };
    for (
      const mode of ['id', 'rooms', 'alias', 'invite', 'race', 'encrypted']
    ) {
      stripEncryption = mode === 'race';
      room = await makeFakeRoom({
        roomId: '!' + mode + ':' + fake.name,
        server: remote,
      });
      if (stripEncryption || mode === 'encrypted') {
        await room.addEvent({
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        });
      }
      if (mode === 'invite') {
        const invitation = await room.addEvent({
          type: 'm.room.member',
          state_key: user.user_id,
          content: { membership: 'invite' },
        });
        await receiveInvite(
          room.roomId,
          String(invitation.event_id),
          { room_version: '11', event: invitation, invite_room_state: [] },
          fake.name,
          inviteDeps(),
        );
      }
      const path = mode === 'rooms'
        ? 'rooms/' + encodeURIComponent(room.roomId) + '/join'
        : 'join/' +
          encodeURIComponent(
            mode === 'alias' ? '#policy:' + fake.name : room.roomId,
          );
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/' + path, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + user.access_token },
          body: '{}',
        }),
      );
      const body = await response.json();
      assertEquals(
        response.status,
        mode === 'encrypted' ? 200 : 400,
        JSON.stringify(body),
      );
      assertEquals(remoteMembership, mode === 'encrypted' ? 'join' : 'leave');
      assertEquals(await pendingJoinAttempts(http.app.server), []);
      if (mode !== 'encrypted') {
        await assertRejects(
          () => openRoom(http.app.store, room.roomId),
          Deno.errors.NotFound,
        );
      } else {
        assertEquals(body.room_id, room.roomId);
        const held = await openRoom(http.app.store, room.roomId);
        assert((await held.tx((tx) => tx.segments.openStay())) !== null);
      }
    }
    assertEquals(
      fake.requests.filter((r) => r.path.includes('/send_join/')).length,
      6,
    );
    assertEquals(
      fake.requests.filter((r) => r.path.includes('/send_leave/')).length,
      5,
    );
    assertEquals(signer.serverName, 'test');
  } finally {
    await http.close();
    await fake.close();
    setConfigForTests(old);
  }
});

Deno.test('E6 production federation startup discovers interrupted join cleanup after store reopen', async () => {
  const old = config();
  strict();
  const dir = await Deno.makeTempDir();
  const settings = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let app = await openApp(settings);
  let membership = 'join';
  const tenantKey = {
    server_name: 'test',
    verify_keys: { [app.tenant.keyId]: { key: app.tenant.publicB64 } },
  };
  const fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(tenantKey),
    handlers: (req) => {
      if (req.path.includes('/make_leave/')) {
        return Response.json({
          room_version: '11',
          event: {
            type: 'm.room.member',
            prev_events: [],
            auth_events: [],
            depth: 1,
          },
        });
      }
      if (req.path.includes('/send_leave/')) {
        assert(req.verified);
        assertEquals((req.json() as Pdu).content.membership, 'leave');
        membership = 'leave';
        return Response.json({});
      }
      return null;
    },
  });
  try {
    const attempt = {
      roomId: '!abandoned:' + fake.name,
      userId: '@a:test',
      eventId: '$uncommitted',
      roomVersion: '11',
      destination: fake.name,
      addedMs: Date.now(),
    };
    await beginJoinAttempt(app.store, attempt);
    releaseJoinAttempt(app.store, attempt);
    await closeApp();
    app = await openApp(settings);
    startFederationServices(app);
    const end = Date.now() + 10000;
    while ((await pendingJoinAttempts(app.server)).length && Date.now() < end) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assertEquals(membership, 'leave');
    assertEquals(await pendingJoinAttempts(app.server), []);
    assertEquals(
      fake.requests.filter((r) => r.path.includes('/send_leave/')).length,
      1,
    );
  } finally {
    await closeApp();
    await fake.close();
    setConfigForTests(old);
    await Deno.remove(dir, { recursive: true });
  }
});
