import { assert, assertEquals } from '@std/assert';
import { httpSuite, startHttp } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { theApp } from '#engine/app.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { cachedDeviceKeys } from '#engine/server/remote-devices.ts';

const suite = httpSuite('HTTP causal device cache');
suite.test('device-list EDU invalidates the shared peer at sync, ignores origin spoofing', async () => {
  const a = await suite.registerTestUser('resync-client', 'pw');
  const remote = await remoteServer();
  const user = '@bob:' + remote.name;
  await theApp().server.tx((tx) =>
    reconcileDeviceRoom(tx, '!cache:local', [a.user_id, user], false, null, 1)
  );
  const sync = async (since = '') => {
    const r = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync' + (since ? '?since=' + since : ''),
        { headers: { authorization: 'Bearer ' + a.access_token } },
      ),
    );
    assertEquals(r.status, 200);
    return await r.json();
  };
  const before = await sync();
  const call = fedCaller(suite.matrix, remote);
  const send = async (subject: string, id: string) => {
    const r = await call('PUT', '/_matrix/federation/v1/send/' + id, {
      origin: remote.name,
      origin_server_ts: Date.now(),
      pdus: [],
      edus: [{
        edu_type: 'm.device_list_update',
        content: {
          user_id: subject,
          device_id: 'D',
          stream_id: 10,
          prev_id: [],
        },
      }],
    });
    assertEquals(r.status, 200);
  };
  await send(user, 'real');
  const after = await sync(before.next_batch);
  assert(after.device_lists.changed.includes(user));
  await send(a.user_id, 'spoof');
  const spoof = await sync(after.next_batch);
  assertEquals(spoof.device_lists.changed, []);
});

Deno.test('lazy device recovery: membership is dormant; query demand and an EDU gap each fetch once', async () => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const http = await startHttp();
  let user = '', snapshots = 0, claims = 0;
  let paused = false, release: (() => void) | undefined;
  const key = {
    user_id: '',
    device_id: 'D',
    algorithms: [],
    keys: { 'ed25519:D': 'origin-key' },
    signatures: {},
  };
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: http.app.tenant.serverName,
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (req.path.includes('/user/devices/')) {
        return (async () => {
          snapshots++;
          if (paused) {
            await new Promise<void>((r) => {
              release = r;
            });
          }
          await new Promise((r) => setTimeout(r, 80));
          return Response.json({
            user_id: user,
            stream_id: 10,
            devices: [{ device_id: 'D', keys: key }],
          });
        })();
      }
      if (req.path.endsWith('/user/keys/claim')) {
        claims++;
        return Response.json({
          one_time_keys: {
            [user]: { D: { 'signed_curve25519:one': { key: 'once' } } },
          },
        });
      }
      return null;
    },
  });
  user = '@remote:' + fake.name;
  key.user_id = user;
  try {
    const a = await http.registerTestUser('lazy-cache', 'pw');
    http.app.deviceLists.start();
    const relationship = (members: string[], pos: number) =>
      http.app.server.tx((tx) =>
        reconcileDeviceRoom(tx, '!lazy:local', members, false, null, pos, [
          http.app.tenant.serverName,
        ])
      );
    await relationship([a.user_id, user], 1);
    await new Promise((r) => setTimeout(r, 1200));
    assertEquals(snapshots, 0, 'membership alone must not dial a remote user');
    assertEquals(
      (await http.app.server.query(
        'SELECT stale FROM remote_device_users WHERE user_id=?',
        [user],
      ))[0].stale,
      1,
    );
    const query = async () => {
      const r = await http.matrix(
        new Request('http://x/_matrix/client/v3/keys/query', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + a.access_token },
          body: JSON.stringify({ device_keys: { [user]: [] } }),
        }),
      );
      assertEquals(r.status, 200);
      assertEquals((await r.json()).device_keys[user].D.keys, key.keys);
    };
    await Promise.all([query(), query(), query()]);
    assertEquals(
      snapshots,
      1,
      'concurrent explicit key demand is single-flight',
    );
    const call = fedCaller(http.matrix, await remoteServer(fake.name));
    const response = await call('PUT', '/_matrix/federation/v1/send/lazy-gap', {
      origin: fake.name,
      origin_server_ts: Date.now(),
      pdus: [],
      edus: [{
        edu_type: 'm.device_list_update',
        content: {
          user_id: user,
          device_id: 'D',
          stream_id: 20,
          prev_id: [999],
          keys: key,
        },
      }],
    });
    assertEquals(response.status, 200);
    const until = Date.now() + 5000;
    while (
      await cachedDeviceKeys(http.app.server, user, [], a.user_id) === null
    ) {
      assert(Date.now() < until, 'EDU gap did not trigger recovery');
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(snapshots, 2);
    await query();
    assertEquals(snapshots, 2);
    await relationship([a.user_id], 2);
    await relationship([a.user_id, user], 3);
    await new Promise((r) => setTimeout(r, 1100));
    assertEquals(snapshots, 2, 'rejoin remains dormant until fresh demand');
    paused = true;
    const started = Date.now();
    const timed = await http.matrix(
      new Request('http://x/_matrix/client/v3/keys/query', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + a.access_token },
        body: JSON.stringify({
          timeout: 200,
          device_keys: { [user]: [], [a.user_id]: [] },
        }),
      }),
    );
    assertEquals(timed.status, 200);
    const timedBody = await timed.json();
    assert(
      Date.now() - started < 1500,
      'snapshot phase exceeded the client deadline',
    );
    assert(timedBody.failures[fake.name]);
    assertEquals(timedBody.device_keys[a.user_id], {});
    assertEquals(snapshots, 3);
    paused = false;
    release!();
    await new Promise((r) => setTimeout(r, 150));
    assertEquals(
      await cachedDeviceKeys(http.app.server, user, [], a.user_id),
      null,
      'late snapshot cannot publish after cancellation',
    );
    const claim = await http.matrix(
      new Request('http://x/_matrix/client/v3/keys/claim', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + a.access_token },
        body: JSON.stringify({
          one_time_keys: { [user]: { D: 'signed_curve25519' } },
        }),
      }),
    );
    assertEquals(claim.status, 200);
    assertEquals((await claim.json()).one_time_keys[user].D, {
      'signed_curve25519:one': { key: 'once' },
    });
    assertEquals(snapshots, 4);
    assertEquals(claims, 1, 'consuming claim remains one-shot');
  } finally {
    release?.();
    await http.close();
    await fake.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});

suite.test('single-flight signed snapshot reaches C-S query; malformed and oversized recovery stays stale with durable retry', async () => {
  const a = await suite.registerTestUser('cache-query', 'pw');
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  let user = '', mode = 'bad', snapshots = 0, queries = 0;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const key = (id: string) => ({
    user_id: user,
    device_id: id,
    algorithms: [],
    keys: { ['ed25519:' + id]: 'origin-' + id },
    signatures: {},
  });
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: theApp().tenant.serverName,
        verify_keys: {
          [theApp().tenant.keyId]: { key: theApp().tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (req.path.includes('/user/devices/')) {
        assert(req.verified);
        snapshots++;
        if (mode === 'bad') {
          return Response.json({
            user_id: user,
            stream_id: 1,
            devices: 'broken',
          });
        }
        if (mode === 'oversize') {
          return Response.json({
            user_id: user,
            stream_id: 1,
            devices: Array.from(
              { length: config().e2ee.maxkeys + 1 },
              (_, i) => ({ device_id: String(i) }),
            ),
          });
        }
        const response = {
          user_id: user,
          stream_id: mode === 'covered' ? 50 : 10,
          devices: [{ device_id: 'D', keys: key('D') }],
        };
        if (mode === 'race' || mode === 'covered') {
          return (async () => {
            await new Promise<void>((r) => {
              release = r;
              entered!();
            });
            return Response.json(response);
          })();
        }
        return Response.json(response);
      }
      if (req.path.endsWith('/user/keys/query')) {
        queries++;
        return Response.json({
          device_keys: { [user]: { FALLBACK: key('FALLBACK') } },
        });
      }
      return null;
    },
  });
  user = '@bob:' + fake.name;
  const call = fedCaller(suite.matrix, await remoteServer(fake.name));
  const send = async (
    stream: number,
    prev: number[],
    id = 'D',
    subject = user,
  ) => {
    const r = await call(
      'PUT',
      '/_matrix/federation/v1/send/cache-' + stream + '-' + id,
      {
        origin: fake.name,
        origin_server_ts: Date.now(),
        pdus: [],
        edus: [{
          edu_type: 'm.device_list_update',
          content: {
            user_id: subject,
            device_id: id,
            stream_id: stream,
            prev_id: prev,
            keys: key(id),
          },
        }],
      },
    );
    assertEquals(r.status, 200);
  };
  const query = async () => {
    const r = await suite.matrix(
      new Request('http://x/_matrix/client/v3/keys/query', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + a.access_token },
        body: JSON.stringify({ device_keys: { [user]: [] } }),
      }),
    );
    assertEquals(r.status, 200);
    return (await r.json()).device_keys[user];
  };
  try {
    // Unshared updates never allocate unsolicited remote-user state.
    await send(1, []);
    assertEquals(
      await theApp().server.query(
        'SELECT user_id FROM remote_device_users WHERE user_id=?',
        [user],
      ),
      [],
    );
    await theApp().server.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!query-cache:local',
        [a.user_id, user],
        false,
        null,
        1,
      )
    );
    await send(2, []);
    await Promise.all([
      theApp().deviceLists.recover(user),
      theApp().deviceLists.recover(user),
    ]);
    assertEquals(snapshots, 1);
    assertEquals(
      await cachedDeviceKeys(theApp().server, user, [], a.user_id),
      null,
    );
    const retry = (await theApp().server.query(
      'SELECT failures,retry_at FROM remote_device_users WHERE user_id=?',
      [user],
    ))[0];
    assertEquals(retry.failures, 1);
    assert(Number(retry.retry_at) > Date.now());
    assertEquals(Object.keys(await query()), ['FALLBACK']);
    mode = 'oversize';
    await theApp().deviceLists.recover(user);
    assertEquals(
      await cachedDeviceKeys(theApp().server, user, [], a.user_id),
      null,
    );
    mode = 'race';
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const recovery = theApp().deviceLists.recover(user);
    await ready;
    await send(20, [10], 'NEW');
    release!();
    await recovery;
    const cached = await query();
    assertEquals(Object.keys(cached).sort(), ['D', 'NEW']);
    assertEquals(cached.NEW.keys, { 'ed25519:NEW': 'origin-NEW' });
    assertEquals(
      queries,
      1,
      'complete cache must serve the C-S consumer without a query dial',
    );
    await send(30, [999]);
    mode = 'covered';
    const coveredReady = new Promise<void>((r) => {
      entered = r;
    });
    const coveredRecovery = theApp().deviceLists.recover(user);
    await coveredReady;
    await send(40, [30], 'OLD');
    await send(50, [40], 'D');
    await send(60, [50], 'NEW');
    release!();
    await coveredRecovery;
    assertEquals(Object.keys(await query()).sort(), ['D', 'NEW']);
    assertEquals(
      queries,
      1,
      'covered updates must not force an origin-query fallback',
    );
    // A missing predecessor durably invalidates and periodic recovery resumes it.
    await send(70, [999]);
    mode = 'good';
    await theApp().server.execute(
      'UPDATE remote_device_users SET retry_at=0 WHERE user_id=?',
      [user],
    );
    theApp().deviceLists.start();
    const deadline = Date.now() + 5000;
    while (
      await cachedDeviceKeys(theApp().server, user, [], a.user_id) === null
    ) {
      assert(Date.now() < deadline, 'durable stale retry did not recover');
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(Object.keys(await query()), ['D']);
    assertEquals(queries, 1);
  } finally {
    release?.();
    await theApp().deviceLists.stop();
    await fake.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});
