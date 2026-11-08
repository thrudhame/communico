import { assertEquals, assertRejects } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import { fakeFetcher } from './fixtures/remote.ts';
import { loginUser } from '#engine/tenant/users.ts';

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
