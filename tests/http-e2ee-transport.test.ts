import { assertEquals, assertRejects } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { fakeFetcher } from './fixtures/remote.ts';
import { loginUser } from '#engine/tenant/users.ts';
import { MatrixError } from '#engine/matrix-error.ts';

const suite = httpSuite('HTTP E3 reliable to-device transport');
async function sync(token: string) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync', {
      headers: { Authorization: 'Bearer ' + token },
    }),
  );
  assertEquals(response.status, 200);
  return await response.json();
}
suite.test('disabled federation refuses remote admission atomically and preserves local sends', async () => {
  const a = await suite.registerTestUser('transport-a', 'pw');
  const before = config().federation.enabled;
  try {
    setConfigForTests({ federation: { enabled: false } });
    const send = (txn: string, messages: unknown) =>
      suite.matrix(
        new Request(
          'http://x/_matrix/client/v3/sendToDevice/m.test/' + txn,
          {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + a.access_token },
            body: JSON.stringify({ messages }),
          },
        ),
      );
    assertEquals(
      (await send('mixed', {
        [a.user_id]: { '*': { n: 1 } },
        '@remote:other.test': { '*': { n: 2 } },
      })).status,
      403,
    );
    assertEquals((await sync(a.access_token!)).to_device.events, []);
    assertEquals(
      (await send('mixed', { [a.user_id]: { '*': { n: 3 } } })).status,
      200,
    );
    assertEquals((await sync(a.access_token!)).to_device.events[0].content, {
      n: 3,
    });
  } finally {
    setConfigForTests({ federation: { enabled: before } });
  }
});

suite.test('remote reliable acceptance reaches sync, dedups across transactions and never caches failed persistence', async () => {
  const b = await suite.registerTestUser('transport-b', 'pw');
  const app = theApp();
  const deps = {
    store: app.store,
    self: app.tenant.serverName,
    keys: { verifyEventSignature: () => Promise.resolve(false) },
    fetcher: fakeFetcher({}).fetcher,
    edus: app.federationEdus,
  };
  const content = {
    sender: '@alice:remote.test',
    type: 'm.test',
    message_id: 'logical-1',
    messages: {
      [b.user_id]: {
        '*': { ciphertext: 'opaque' },
        unknown: { ignored: true },
      },
      '@foreign:elsewhere.test': { '*': { ignored: true } },
    },
  };
  const receive = (txn: string, value: unknown = content) =>
    receiveTransaction('remote.test', txn, {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [],
      edus: [{ edu_type: 'm.direct_to_device', content: value }],
    }, deps);
  assertEquals((await receive('first')).status, 200);
  assertEquals((await sync(b.access_token!)).to_device.events, [{
    sender: content.sender,
    type: content.type,
    content: { ciphertext: 'opaque' },
  }]);
  await loginUser(app.tenant, {
    localpart: 'transport-b',
    password: 'pw',
    deviceId: 'LATE',
    refresh: false,
  });
  await receive('different-transport-id');
  assertEquals((await sync(b.access_token!)).to_device.events.length, 1);
  const tenant = await app.store.tenant(app.tenant.serverName);
  assertEquals(
    (await tenant.query(
      "SELECT COUNT(*) AS n FROM to_device_inbox WHERE localpart='transport-b'",
    ))[0].n,
    1,
  );
  await receive('spoofed', {
    ...content,
    message_id: 'spoof',
    sender: '@alice:elsewhere.test',
  });
  await receive('malformed', {
    ...content,
    message_id: 'malformed',
    messages: [],
  });
  assertEquals((await sync(b.access_token!)).to_device.events.length, 1);
  const limits = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxinboxmessages: 1 } });
    const second = { ...content, message_id: 'logical-2' };
    await assertRejects(() => receive('retryable', second));
    assertEquals(
      await app.server.query(
        "SELECT 1 FROM federation_txns WHERE txn_id='retryable'",
      ),
      [],
    );
    assertEquals(
      await tenant.query(
        "SELECT 1 FROM inbound_to_device WHERE message_id='logical-2'",
      ),
      [],
    );
    setConfigForTests({ e2ee: limits });
    await receive('retryable', second);
    assertEquals((await sync(b.access_token!)).to_device.events.length, 2);
  } finally {
    setConfigForTests({ e2ee: limits });
  }
});

suite.test('inbound wildcard expands local devices beyond the wire key cap without partial delivery', async () => {
  const user = await suite.registerTestUser('wildcard-owner', 'pw');
  const app = theApp();
  const tokens = [user.access_token!];
  for (const deviceId of ['PHONE', 'TABLET', 'LAPTOP']) {
    tokens.push(
      (await loginUser(app.tenant, {
        localpart: 'wildcard-owner',
        password: 'pw',
        deviceId,
        refresh: false,
      })).accessToken,
    );
  }
  const previous = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxkeys: 1 } });
    const result = await receiveTransaction('wild.test', 'all-local-devices', {
      origin: 'wild.test',
      origin_server_ts: Date.now(),
      pdus: [],
      edus: [{
        edu_type: 'm.direct_to_device',
        content: {
          sender: '@sender:wild.test',
          type: 'm.test',
          message_id: 'all-local-devices',
          messages: { [user.user_id]: { '*': { encrypted: 'all' } } },
        },
      }],
    }, {
      store: app.store,
      self: app.tenant.serverName,
      keys: { verifyEventSignature: () => Promise.resolve(false) },
      fetcher: fakeFetcher({}).fetcher,
      edus: app.federationEdus,
    });
    assertEquals(result.status, 200);
    for (const token of tokens) {
      assertEquals((await sync(token)).to_device.events, [{
        sender: '@sender:wild.test',
        type: 'm.test',
        content: { encrypted: 'all' },
      }]);
    }
  } finally {
    setConfigForTests({ e2ee: previous });
  }
});

suite.test('permanent EDU refusal is visible and lets later work through; storage failures still retry', async () => {
  const user = await suite.registerTestUser('refusal-recipient', 'pw');
  const app = theApp();
  const origin = 'refusal.test';
  const deps = {
    store: app.store,
    self: app.tenant.serverName,
    keys: { verifyEventSignature: () => Promise.resolve(false) },
    fetcher: fakeFetcher({}).fetcher,
    edus: app.federationEdus,
  };
  const valid = {
    edu_type: 'm.direct_to_device',
    content: {
      sender: '@sender:' + origin,
      type: 'm.test',
      message_id: 'after-refusal',
      messages: { [user.user_id]: { '*': { encrypted: 'later' } } },
    },
  };
  const invalid = {
    edu_type: 'm.direct_to_device',
    content: {
      ...valid.content,
      message_id: 'refused',
      messages: {
        [user.user_id]: {
          '*': { oversized: 'x'.repeat(config().e2ee.maxkeybytes + 1) },
        },
      },
    },
  };
  const before = await app.server.query(
    "SELECT value FROM counters WHERE name='federation-edu-refused:m.direct_to_device'",
  );
  const body = {
    origin,
    origin_server_ts: Date.now(),
    pdus: [],
    edus: [invalid, valid],
  };
  assertEquals(
    (await receiveTransaction(origin, 'refusal-then-valid', body, deps)).status,
    200,
  );
  assertEquals((await sync(user.access_token!)).to_device.events[0].content, {
    encrypted: 'later',
  });
  const pending = await app.server.query(
    "SELECT count,detail FROM federation_pending WHERE name=? AND kind='refused'",
    [origin],
  );
  assertEquals(pending.length, 1);
  assertEquals(pending[0].count, 1);
  const detail = JSON.parse(String(pending[0].detail));
  assertEquals(detail.direction, 'inbound');
  assertEquals(detail.edu_type, 'm.direct_to_device');
  assertEquals(detail.errcode, 'M_TOO_LARGE');
  const count = await app.server.query(
    "SELECT value FROM counters WHERE name='federation-edu-refused:m.direct_to_device'",
  );
  assertEquals(
    count[0].value,
    (before.length ? Number(before[0].value) : 0) + 1,
  );
  await receiveTransaction(origin, 'refusal-then-valid', body, deps);
  assertEquals(
    (await app.server.query(
      "SELECT count FROM federation_pending WHERE name=? AND kind='refused'",
      [origin],
    ))[0].count,
    1,
  );
  const tenant = await app.store.tenant(app.tenant.serverName);
  assertEquals(
    await tenant.query(
      "SELECT 1 FROM inbound_to_device WHERE origin=? AND message_id='refused'",
      [origin],
    ),
    [],
  );
  const original = app.tenant.tx;
  try {
    // A storage error's status is not a permanent policy classification.
    for (const status of [503, 413]) {
      app.tenant.tx = () =>
        Promise.reject(
          new MatrixError(status, 'M_UNKNOWN', 'injected persistence failure'),
        );
      await assertRejects(() =>
        receiveTransaction(origin, 'storage-retry', {
          origin_server_ts: Date.now(),
          origin,
          pdus: [],
          edus: [{
            ...valid,
            content: { ...valid.content, message_id: 'storage-retry' },
          }],
        }, deps)
      );
      assertEquals(
        await app.server.query(
          "SELECT 1 FROM federation_txns WHERE txn_id='storage-retry'",
        ),
        [],
      );
    }
  } finally {
    app.tenant.tx = original;
  }
  await receiveTransaction(origin, 'storage-retry', {
    origin_server_ts: Date.now(),
    origin,
    pdus: [],
    edus: [{
      ...valid,
      content: { ...valid.content, message_id: 'storage-retry' },
    }],
  }, deps);
  assertEquals((await sync(user.access_token!)).to_device.events.length, 2);
});
