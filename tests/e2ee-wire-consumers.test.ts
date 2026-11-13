import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { publicDeviceKey, remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { publicSigning } from '#engine/e2ee-public-signing.ts';
import { queryKeys } from '#engine/client/e2ee.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { startHttp } from '#tests/http-app.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';

const user = '@bob:remote.test';
const material = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const device = () => ({
  user_id: user,
  device_id: 'D',
  algorithms: [],
  keys: { 'ed25519:D': material },
  signatures: {},
});

Deno.test('C1 DeviceKeys requires signatures instead of inventing a signed field', () => {
  const { signatures: _signatures, ...key } = device();
  const error = assertThrows(() =>
    publicDeviceKey(key, user, 'D', config().e2ee)
  );
  assert(error instanceof UpstreamError);
  assertEquals(error.category, 'protocol');
});

Deno.test('C1 snapshot and public signing share optional peer-field null absence', () => {
  const raw = {
    user_id: user,
    stream_id: '00023',
    devices: [{ device_id: 'D', keys: device() }],
    master_key: null,
    self_signing_key: null,
  };
  const parsed = remoteDeviceSnapshot(raw, user, config().e2ee);
  assertEquals(parsed.stream, '23');
  assertEquals(parsed.signing, {});
  assertEquals(publicSigning(raw, user, config().e2ee), {});
  assertEquals(raw.master_key, null, 'decoding must not edit signed input');
});

Deno.test('C1 snapshot device keys are required even when EDU keys may be absent', () => {
  const error = assertThrows(() =>
    remoteDeviceSnapshot(
      {
        user_id: user,
        stream_id: 1,
        devices: [{ device_id: 'D' }],
      },
      user,
      config().e2ee,
    )
  );
  assert(error instanceof UpstreamError);
  assertEquals(error.category, 'protocol');
});

Deno.test('C1 remote key material uses Matrix base64 while preserving valid padding', () => {
  const key = device();
  key.keys['ed25519:D'] = material + '=';
  assertEquals(publicDeviceKey(key, user, 'D', config().e2ee).keys, key.keys);
  for (const value of ['_', 'AA', material.slice(0, -1) + 'B']) {
    key.keys['ed25519:D'] = value;
    const error = assertThrows(() =>
      publicDeviceKey(key, user, 'D', config().e2ee)
    );
    assert(error instanceof UpstreamError);
    assertEquals(error.category, 'protocol');
  }
  key.keys['ed25519:D'] = material;
  key.user_id = '@other:remote.test';
  const error = assertThrows(() =>
    publicDeviceKey(key, user, 'D', config().e2ee)
  );
  assert(error instanceof UpstreamError);
  assertEquals(error.category, 'validation');
});

Deno.test('C1 key query propagates local admission storage failure unchanged', async () => {
  const http = await startHttp();
  try {
    const client = await http.registerTestUser('wire-local-fault', 'pw');
    const db = http.app.server, original = db.query;
    const fault = new Error('injected local roster failure');
    db.query = () => Promise.reject(fault);
    try {
      const error = await assertRejects(() =>
        queryKeys(client.user_id, {
          device_keys: { [user]: [] },
        })
      );
      assertEquals(error, fault);
    } finally {
      db.query = original;
    }
  } finally {
    await http.close();
  }
});

Deno.test('C1 claimed signed keys are decoded completely and never retried', async (t) => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const http = await startHttp();
  let remote = '', calls = 0, key: unknown;
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: http.app.tenant.serverName,
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (!req.path.endsWith('/user/keys/claim')) return null;
      calls++;
      return Response.json({
        one_time_keys: {
          [remote]: { D: { 'signed_curve25519:claimed': key } },
        },
      });
    },
  });
  remote = '@bob:' + fake.name;
  try {
    const client = await http.registerTestUser('wire-claim', 'pw');
    const cases: [unknown, boolean][] = [
      [{ key: material }, false],
      [{ key: material, signatures: null }, false],
      [{ key: material, signatures: { [remote]: { 'ed25519:D': 3 } } }, false],
      [{ key: material, signatures: {}, fallback: 'true' }, false],
      [{ key: material, signatures: {}, fallback: null }, true],
      [material, false],
      [
        { key: material + '=', signatures: {}, fallback: true, extension: 1 },
        true,
      ],
    ];
    for (const [candidate, valid] of cases) {
      await t.step(JSON.stringify(candidate), async () => {
        key = candidate;
        const before = calls;
        const response = await http.matrix(
          new Request('http://x/_matrix/client/v3/keys/claim', {
            method: 'POST',
            headers: { authorization: 'Bearer ' + client.access_token },
            body: JSON.stringify({
              one_time_keys: { [remote]: { D: 'signed_curve25519' } },
            }),
          }),
        );
        assertEquals(response.status, 200);
        const body = await response.json();
        assertEquals(calls, before + 1);
        assertEquals(
          body.one_time_keys[remote]?.D,
          valid ? { 'signed_curve25519:claimed': key } : undefined,
        );
        assertEquals(Boolean(body.failures[fake.name]), !valid);
      });
    }
  } finally {
    await fake.close();
    await http.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});

Deno.test('C1 key query treats null optional signing maps as absent but rejects null map values', async () => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const http = await startHttp();
  let remote = '', malformed = false;
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: http.app.tenant.serverName,
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (request) =>
      request.path.endsWith('/user/keys/query')
        ? Response.json({
          device_keys: { [remote]: {} },
          master_keys: malformed ? { [remote]: null } : null,
          self_signing_keys: null,
        })
        : null,
  });
  remote = '@bob:' + fake.name;
  try {
    const client = await http.registerTestUser('null-optional-maps', 'pw');
    for (const invalid of [false, true]) {
      malformed = invalid;
      const answer = await queryKeys(client.user_id, {
        device_keys: { [remote]: [] },
      });
      assertEquals(
        Boolean((answer.failures as Record<string, unknown>)[fake.name]),
        invalid,
      );
      assertEquals(answer.master_keys, {});
      assertEquals(answer.self_signing_keys, {});
    }
  } finally {
    await fake.close();
    await http.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});

Deno.test('C1 recovery charges only peer failures, not local storage or revision fences', async () => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const http = await startHttp();
  let remote = '', mode = 'valid';
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: http.app.tenant.serverName,
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (!req.path.includes('/user/devices/')) return null;
      return (async () => {
        if (mode === 'race') {
          await http.app.server.execute(
            'UPDATE remote_device_users SET revision=revision+1 WHERE user_id=?',
            [remote],
          );
        }
        return Response.json({
          user_id: remote,
          stream_id: 7,
          devices: mode === 'malformed' ? null : [],
        });
      })();
    },
  });
  remote = '@bob:' + fake.name;
  try {
    const client = await http.registerTestUser('wire-recover', 'pw');
    const db = http.app.server;
    await db.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!wire:local',
        [client.user_id, remote],
        false,
        null,
        1,
        [http.app.tenant.serverName],
      )
    );
    const original = db.tx;
    const fault = new Error('injected snapshot persistence failure');
    let injected = 0;
    db.tx = (fn, options) =>
      original(async (tx) => {
        const execute = tx.execute.bind(tx);
        tx.execute = (sql, args) => {
          if (sql.startsWith('DELETE FROM remote_device_keys')) {
            injected++;
            throw fault;
          }
          return execute(sql, args);
        };
        return await fn(tx);
      }, options);
    try {
      const error = await assertRejects(() =>
        http.app.deviceLists.recover(remote)
      );
      assertEquals(error, fault);
    } finally {
      db.tx = original;
    }
    assertEquals(injected, 1);
    const row = (await db.query(
      'SELECT failures,retry_at,stale FROM remote_device_users WHERE user_id=?',
      [remote],
    ))[0];
    assertEquals(row, { failures: 0, retry_at: 0, stale: 1 });
    mode = 'race';
    await http.app.deviceLists.recover(remote);
    const fenced = (await db.query(
      'SELECT failures,retry_at,stale FROM remote_device_users WHERE user_id=?',
      [remote],
    ))[0];
    assertEquals(fenced.failures, 0);
    assertEquals(fenced.stale, 1);
    assert(
      Number(fenced.retry_at) > 0,
      'local revision fences retain scheduled recovery',
    );
    mode = 'malformed';
    await http.app.deviceLists.recover(remote);
    const peer = (await db.query(
      'SELECT failures,retry_at,stale FROM remote_device_users WHERE user_id=?',
      [remote],
    ))[0];
    assertEquals(peer.failures, 1);
    assertEquals(peer.stale, 1);
    assert(Number(peer.retry_at) > Date.now());
  } finally {
    await fake.close();
    await http.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});
