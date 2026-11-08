import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';

type Json = Record<string, unknown>;
type KeyResponse = {
  device_keys: Record<string, Record<string, { keys: Json }>>;
  one_time_keys: Record<string, Record<string, Json>>;
  failures: Json;
};
const suite = httpSuite('HTTP E3 federated key consumers');
async function post(token: string, path: string, body: unknown) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/keys/' + path, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }),
  );
  assertEquals(response.status, 200, await response.clone().text());
  return await response.json() as KeyResponse;
}

suite.test('authenticated own-domain snapshots and C-S/federation claims share one consuming pool', async () => {
  const a = await suite.registerTestUser('fed-keys-a', 'pw');
  const keys = {
    user_id: a.user_id,
    device_id: a.device_id,
    algorithms: [],
    keys: {},
    signatures: {
      [a.user_id]: { ['ed25519:' + a.device_id]: 'owner' },
      '@private:elsewhere.test': { x: 'hidden' },
    },
  };
  await post(a.access_token!, 'upload', {
    device_keys: keys,
    one_time_keys: {
      'curve25519:first': 'first',
      'curve25519:second': 'second',
    },
  });
  const call = fedCaller(suite.matrix, await remoteServer());
  const base = '/_matrix/federation/v1/user/';
  const path = base + 'devices/' + encodeURIComponent(a.user_id);
  const unsigned = await suite.matrix(new Request('http://x' + path));
  assertEquals(unsigned.status, 401);
  await unsigned.body?.cancel();
  const snapshot = await call('GET', path);
  assertEquals(snapshot.status, 200);
  assertEquals(snapshot.body.user_id, a.user_id);
  const devices = snapshot.body.devices as { device_id: string; keys: Json }[];
  assertEquals(devices.length, 1);
  assertEquals(devices[0].device_id, a.device_id);
  assertEquals(devices[0].keys.signatures, {
    [a.user_id]: keys.signatures[a.user_id],
  });
  const db = await theApp().store.tenant(theApp().tenant.serverName);
  assertEquals(
    snapshot.body.stream_id,
    (await db.query('SELECT value FROM user_device_stream WHERE localpart=?', [
      'fed-keys-a',
    ]))[0].value,
  );
  const query = await call('POST', base + 'keys/query', {
    device_keys: { [a.user_id]: [] },
  });
  assertEquals(query.status, 200);
  assertEquals(
    (query.body as unknown as KeyResponse).device_keys[a.user_id][a.device_id],
    devices[0].keys,
  );
  assertEquals(
    (await call(
      'GET',
      base + 'devices/' + encodeURIComponent('@x:foreign.test'),
    )).status,
    400,
  );
  const foreign = {
    [a.user_id]: { [a.device_id]: 'curve25519' },
    '@x:foreign.test': { D: 'curve25519' },
  };
  assertEquals(
    (await call('POST', base + 'keys/claim', { one_time_keys: foreign }))
      .status,
    400,
  );
  const claim = {
    one_time_keys: { [a.user_id]: { [a.device_id]: 'curve25519' } },
  };
  const answers = await Promise.all([
    call('POST', base + 'keys/claim', claim).then((x) =>
      x.body as unknown as KeyResponse
    ),
    post(a.access_token!, 'claim', claim),
  ]);
  assertEquals(
    answers.flatMap((x) => Object.keys(x.one_time_keys[a.user_id][a.device_id]))
      .sort(),
    ['curve25519:first', 'curve25519:second'],
  );
  assertEquals((await call('POST', base + 'keys/claim', claim)).body, {
    one_time_keys: {},
  });
});

suite.test('signed remote grouping preserves local successes, rejects injection and never retries consuming claims', async () => {
  const a = await suite.registerTestUser('remote-key-client', 'pw');
  const old = config().federation.cacerts;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  let mode = 'normal', claims = 0;
  let remote = '';
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: theApp().tenant.serverName,
        verify_keys: {
          [theApp().tenant.keyId]: { key: theApp().tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (!req.path.startsWith('/_matrix/federation/v1/user/keys/')) {
        return null;
      }
      assert(req.verified);
      const body = req.json() as Json;
      const claim = req.path.endsWith('/claim');
      const field = claim ? 'one_time_keys' : 'device_keys';
      assertEquals(
        Object.keys(body[field] as Json).sort(),
        [remote, remote.replace('@bob:', '@carol:')].sort(),
      );
      if (claim) {
        claims++;
        if (mode === 'claim-ok') {
          return Response.json({
            one_time_keys: {
              [remote]: { D: { 'curve25519:r': 'remote-one-time' } },
            },
          });
        }
        return Response.json({ error: 'lost response' }, { status: 503 });
      }
      const key = {
        user_id: remote,
        device_id: 'D',
        algorithms: [],
        keys: { 'ed25519:D': 'remote-public' },
        signatures: {},
      };
      return Response.json({
        device_keys: {
          [remote]: { D: key },
          ...(mode === 'inject'
            ? { [a.user_id]: { D: { ...key, user_id: a.user_id } } }
            : {}),
        },
      });
    },
  });
  remote = '@bob:' + fake.name;
  const carol = remote.replace('@bob:', '@carol:');
  try {
    await post(a.access_token!, 'upload', {
      device_keys: {
        user_id: a.user_id,
        device_id: a.device_id,
        algorithms: [],
        keys: {},
        signatures: {},
      },
    });
    const body = {
      device_keys: {
        [a.user_id]: [],
        [remote]: [],
        [carol]: ['D'],
        '@nope:127.0.0.1:1': [],
      },
    };
    const queried = await post(a.access_token!, 'query', body);
    assertEquals(queried.device_keys[remote].D.keys, {
      'ed25519:D': 'remote-public',
    });
    assert(queried.device_keys[a.user_id][a.device_id]);
    assert(queried.failures['127.0.0.1:1']);
    assertEquals(
      fake.requests.filter((x) => x.path.endsWith('/user/keys/query')).length,
      1,
    );
    mode = 'inject';
    const poisoned = await post(a.access_token!, 'query', body);
    assertEquals(poisoned.device_keys[remote], undefined);
    assert(poisoned.failures[fake.name]);
    assert(poisoned.device_keys[a.user_id][a.device_id]);
    await post(a.access_token!, 'upload', {
      one_time_keys: { 'curve25519:local': 'local' },
    });
    const claimed = await post(a.access_token!, 'claim', {
      one_time_keys: {
        [a.user_id]: { [a.device_id]: 'curve25519' },
        [remote]: { D: 'curve25519' },
        [carol]: { D: 'curve25519' },
      },
    });
    assertEquals(claimed.one_time_keys[a.user_id][a.device_id], {
      'curve25519:local': 'local',
    });
    assert(claimed.failures[fake.name]);
    assertEquals(claims, 1);
    mode = 'claim-ok';
    const received = await post(a.access_token!, 'claim', {
      one_time_keys: {
        [remote]: { D: 'curve25519' },
        [carol]: { D: 'curve25519' },
      },
    });
    assertEquals(received.one_time_keys[remote].D, {
      'curve25519:r': 'remote-one-time',
    });
    assertEquals(received.failures, {});
    assertEquals(claims, 2);
    // The admission gate runs before transport, even for an explicit user query.
    await theApp().server.execute('DELETE FROM federation_peers WHERE name=?', [
      fake.name,
    ]);
    const modeBefore = config().federation.mode;
    try {
      setConfigForTests({ federation: { mode: 'closed' } });
      const requests = fake.requests.length;
      const blocked = await post(a.access_token!, 'claim', {
        one_time_keys: {
          [remote]: { D: 'curve25519' },
          [carol]: { D: 'curve25519' },
        },
      });
      assert(blocked.failures[fake.name]);
      assertEquals(fake.requests.length, requests);
    } finally {
      setConfigForTests({ federation: { mode: modeBefore } });
    }
  } finally {
    await fake.close();
    setConfigForTests({ federation: { cacerts: old } });
    resetCaCertsForTests();
  }
});

suite.test('shared response budgets preserve local keys and bound origin concurrency at the real TLS consumer', async () => {
  const a = await suite.registerTestUser('key-budget-client', 'pw');
  await post(a.access_token!, 'upload', {
    device_keys: {
      user_id: a.user_id,
      device_id: a.device_id,
      algorithms: [],
      keys: {},
      signatures: {},
    },
  });
  const previous = {
    e2ee: { ...config().e2ee },
    federation: { ...config().federation },
  };
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const peers: Awaited<ReturnType<typeof startFakeServer>>[] = [];
  let active = 0, peak = 0;
  const ready = Promise.withResolvers<void>();
  let arrivals = 0;
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let n = 0; n < 6; n++) {
      const fake = await startFakeServer({
        ourKeyDoc: () =>
          Promise.resolve({
            server_name: theApp().tenant.serverName,
            verify_keys: {
              [theApp().tenant.keyId]: { key: theApp().tenant.publicB64 },
            },
          }),
        handlers: (req) => {
          if (!req.path.endsWith('/user/keys/query')) return null;
          return (async () => {
            assert(req.verified);
            active++;
            peak = Math.max(peak, active);
            try {
              if (++arrivals === 1) {
                barrierTimer = setTimeout(
                  () =>
                    ready.reject(
                      new Error(
                        'four origin workers did not reach the consumer',
                      ),
                    ),
                  1500,
                );
              }
              if (arrivals === 4) {
                clearTimeout(barrierTimer);
                ready.resolve();
              }
              if (arrivals <= 4) await ready.promise;
              await new Promise((resolve) => setTimeout(resolve, 40));
              const user = Object.keys(
                (req.json() as { device_keys: Json }).device_keys,
              )[0];
              return Response.json({
                device_keys: {
                  [user]: Object.fromEntries(
                    ['D', 'E'].map(
                      (device_id) => [device_id, {
                        user_id: user,
                        device_id,
                        algorithms: [],
                        keys: {},
                        signatures: {},
                        extra: 'x'.repeat(220),
                      }],
                    ),
                  ),
                },
              });
            } finally {
              active--;
            }
          })();
        },
      });
      peers.push(fake);
    }
    const device_keys = Object.fromEntries([
      [a.user_id, []],
      ...peers.map((p) => ['@remote:' + p.name, []]),
    ]);
    // Each remote response fits; their aggregate does not. Local result remains.
    setConfigForTests({
      e2ee: { maxrequestbytes: 1600 },
      federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    const bytes = await post(a.access_token!, 'query', { device_keys });
    assert(bytes.device_keys[a.user_id][a.device_id]);
    assert(Object.keys(bytes.device_keys).length > 1);
    assert(Object.keys(bytes.failures).length > 0);
    assert(new TextEncoder().encode(JSON.stringify(bytes)).length <= 1600);
    assertEquals(peak, 4);
    setConfigForTests({
      e2ee: { maxrequestbytes: previous.e2ee.maxrequestbytes, maxkeys: 7 },
      federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
    });
    const count = await post(a.access_token!, 'query', { device_keys });
    assertEquals(
      Object.values(count.device_keys).reduce(
        (n, devices) => n + Object.keys(devices).length,
        0,
      ),
      7,
    );
    assertEquals(Object.keys(count.failures).length, 3);
  } finally {
    clearTimeout(barrierTimer);
    await Promise.all(peers.map((p) => p.close()));
    setConfigForTests(previous);
    resetCaCertsForTests();
  }
});

suite.test('query and claim deadlines retain local successes, cancel remote work and never start queued origins', async () => {
  const a = await suite.registerTestUser('key-deadline-client', 'pw');
  const previous = { federation: { ...config().federation } };
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const peers: Awaited<ReturnType<typeof startFakeServer>>[] = [];
  try {
    for (let n = 0; n < 6; n++) {
      peers.push(
        await startFakeServer({
          ourKeyDoc: () =>
            Promise.resolve({
              server_name: theApp().tenant.serverName,
              verify_keys: {
                [theApp().tenant.keyId]: { key: theApp().tenant.publicB64 },
              },
            }),
          handlers: (req) => {
            if (!req.path.includes('/user/keys/')) return null;
            return (async () => {
              await new Promise((resolve) => setTimeout(resolve, 500));
              const claim = req.path.endsWith('/claim');
              const field = claim ? 'one_time_keys' : 'device_keys';
              const user = Object.keys((req.json() as Json)[field] as Json)[0];
              return Response.json({
                [field]: {
                  [user]: {
                    D: claim ? { 'curve25519:late': 'consumed' } : {
                      user_id: user,
                      device_id: 'D',
                      algorithms: [],
                      keys: {},
                      signatures: {},
                    },
                  },
                },
              });
            })();
          },
        }),
      );
    }
    for (const claim of [false, true]) {
      const field = claim ? 'one_time_keys' : 'device_keys';
      await post(a.access_token!, 'upload', {
        device_keys: {
          user_id: a.user_id,
          device_id: a.device_id,
          algorithms: [],
          keys: {},
          signatures: {},
        },
        one_time_keys: { ['curve25519:' + field]: 'local' },
      });
      const before = peers.map((p) => p.requests.length);
      const started = performance.now();
      const result = await post(a.access_token!, claim ? 'claim' : 'query', {
        timeout: 100,
        [field]: Object.fromEntries([
          [a.user_id, claim ? { [a.device_id]: 'curve25519' } : []],
          ...peers.map((
            p,
          ) => ['@remote:' + p.name, claim ? { D: 'curve25519' } : []]),
        ]),
      });
      assert(
        performance.now() - started < 350,
        'remote work exceeded the client deadline',
      );
      assert(
        (result[field] as KeyResponse['device_keys'])[a.user_id][a.device_id],
      );
      assertEquals(
        Object.keys(result.failures).sort(),
        peers.map((p) => p.name).sort(),
      );
      assertEquals(Object.keys(result[field]), [a.user_id]);
      const snapshot = JSON.stringify(result);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assertEquals(
        JSON.stringify(result),
        snapshot,
        'late answer mutated the response',
      );
      assertEquals(
        peers.slice(4).map((p, i) => p.requests.length - before[i + 4]),
        [0, 0],
      );
      for (let n = 0; n < 4; n++) {
        assert(
          peers[n].requests.length - before[n] <= 1,
          'consuming work was retried',
        );
      }
    }
  } finally {
    await Promise.all(peers.map((p) => p.close()));
    setConfigForTests(previous);
    resetCaCertsForTests();
  }
});

suite.test('the same deadline bounds admission and discovery before any consuming dial', async () => {
  const a = await suite.registerTestUser('key-discovery-deadline', 'pw');
  const previous = { federation: { ...config().federation } };
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: theApp().tenant.serverName,
        verify_keys: {
          [theApp().tenant.keyId]: { key: theApp().tenant.publicB64 },
        },
      }),
  });
  const server = theApp().server;
  const query = server.query;
  try {
    for (const stage of ['admission', 'discovery']) {
      let delayed = false;
      let peerReads = 0;
      server.query = async function (sql, values) {
        const target = stage === 'admission'
          ? sql === 'SELECT pattern FROM federation_blocks'
          : sql.includes('FROM federation_peers WHERE name = ?') &&
            ++peerReads === 2;
        if (target) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return await query.call(this, sql, values);
      };
      const started = performance.now();
      const result = await post(a.access_token!, 'claim', {
        timeout: 100,
        one_time_keys: { ['@remote:' + fake.name]: { D: 'curve25519' } },
      });
      assert(delayed, 'did not exercise ' + stage);
      assert(
        performance.now() - started < 350,
        stage + ' ignored the deadline',
      );
      assert(result.failures[fake.name]);
      await new Promise((resolve) => setTimeout(resolve, 600));
      assertEquals(
        fake.requests.length,
        0,
        'late discovery started a consuming dial',
      );
      server.query = query;
    }
  } finally {
    server.query = query;
    await fake.close();
    setConfigForTests(previous);
    resetCaCertsForTests();
  }
});

suite.test('invalid timeout is rejected before local consumption and zero timeout preserves local results', async () => {
  const a = await suite.registerTestUser('key-timeout-input', 'pw');
  await post(a.access_token!, 'upload', {
    one_time_keys: { 'curve25519:safe': 'safe' },
  });
  const one_time_keys = {
    [a.user_id]: { [a.device_id]: 'curve25519' },
    '@remote:127.0.0.1:1': { D: 'curve25519' },
  };
  for (const path of ['query', 'claim']) {
    for (const timeout of [-1, 0.5, '100', null, Number.MAX_SAFE_INTEGER + 1]) {
      const response = await suite.matrix(
        new Request('http://x/_matrix/client/v3/keys/' + path, {
          method: 'POST',
          headers: { authorization: 'Bearer ' + a.access_token },
          body: JSON.stringify({
            timeout,
            device_keys: { [a.user_id]: [] },
            one_time_keys,
          }),
        }),
      );
      assertEquals(response.status, 400);
      await response.body?.cancel();
    }
  }
  const claimed = await post(a.access_token!, 'claim', {
    timeout: 0,
    one_time_keys,
  });
  assertEquals(claimed.one_time_keys[a.user_id][a.device_id], {
    'curve25519:safe': 'safe',
  });
  assert(claimed.failures['127.0.0.1:1']);
});
