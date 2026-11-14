import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { theApp } from '#engine/app.ts';
import { loginUser } from '#engine/tenant/users.ts';
import { config, setConfigForTests } from '#engine/config.ts';

type Json = {
  next_batch: string;
  to_device: {
    events: {
      sender: string;
      type: string;
      content: Record<string, unknown>;
    }[];
  };
  device_one_time_keys_count: Record<string, number>;
  device_unused_fallback_key_types: string[];
};
const suite = httpSuite('HTTP E2 local inbox');
async function call(
  token: string,
  path: string,
  body?: unknown,
  method = 'POST',
  status = 200,
): Promise<Json> {
  const r = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: body === undefined ? 'GET' : method,
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(r.status, status, await r.clone().text());
  return await r.json();
}
const sync = (token: string, since?: string, timeout = 0) =>
  call(
    token,
    'sync?timeout=' + timeout +
      (since ? '&since=' + encodeURIComponent(since) : ''),
  );
const send = (token: string, txn: string, messages: unknown, status = 200) =>
  call(token, 'sendToDevice/m.test/' + txn, { messages }, 'PUT', status);

suite.test('remote admission follows reliable federation availability and mixed sends remain atomic', async () => {
  const a = await suite.registerTestUser('unsupported-a', 'pw');
  const b = await suite.registerTestUser('unsupported-b', 'pw');
  const enabled = config().federation.enabled;
  try {
    for (const federation of [false, true]) {
      setConfigForTests({ federation: { enabled: federation } });
      const txn = 'unsupported-' + federation;
      await send(a.access_token!, txn, {
        [b.user_id]: { '*': { local: true } },
        '@remote:other.test': { '*': { remote: true } },
      }, federation ? 200 : 403);
      const db = await theApp().store.tenant(theApp().tenant.serverName);
      if (federation) {
        const delivered = await sync(b.access_token!);
        assertEquals(delivered.to_device.events.map((e) => e.content), [{
          local: true,
        }]);
        const intent = await db.query(
          'SELECT source_id,payload FROM to_device_intents',
        );
        assertEquals(intent.length, 1);
        assertEquals(JSON.parse(String(intent[0].payload)).messages, {
          '@remote:other.test': { '*': { remote: true } },
        });
        assertEquals(
          (await theApp().server.query(
            'SELECT * FROM edu_outbox WHERE source=?',
            [
              'tenant:' + theApp().tenant.serverName + ':to-device:' +
              intent[0].source_id,
            ],
          )).length,
          1,
        );
        assertEquals(
          (await db.query(
            'SELECT * FROM to_device_transactions WHERE txn_id=?',
            [txn],
          )).length,
          1,
        );
        await sync(b.access_token!, delivered.next_batch);
        continue;
      }
      assertEquals((await sync(b.access_token!)).to_device.events, []);
      assertEquals(await db.query('SELECT * FROM to_device_intents'), []);
      assertEquals(
        await db.query('SELECT * FROM to_device_transactions WHERE txn_id=?', [
          txn,
        ]),
        [],
      );
      // A rejected transaction has no receipt: a local-only retry still delivers.
      await send(a.access_token!, txn, {
        [b.user_id]: { '*': { local: true } },
      });
      const delivered = await sync(b.access_token!);
      assertEquals(delivered.to_device.events.map((e) => e.content), [{
        local: true,
      }]);
      await sync(b.access_token!, delivered.next_batch);
    }
  } finally {
    setConfigForTests({ federation: { enabled } });
  }
});

suite.test('durable send, wildcard snapshot, scoped retries and issued-cut acknowledgments', async () => {
  const a = await suite.registerTestUser('inbox-a', 'pw');
  const b = await suite.registerTestUser('inbox-b', 'pw');
  const second = await loginUser(theApp().tenant, {
    localpart: 'inbox-b',
    password: 'pw',
    deviceId: 'SECOND',
    refresh: false,
  });
  const initial = await sync(b.access_token!);
  await send(a.access_token!, 'same', { [b.user_id]: { '*': { opaque: 1 } } });
  const first = await sync(b.access_token!, initial.next_batch);
  assertEquals(first.to_device.events, [{
    sender: a.user_id,
    type: 'm.test',
    content: { opaque: 1 },
  }]);
  assertEquals(
    (await sync(b.access_token!, initial.next_batch)).to_device,
    first.to_device,
  );
  // Another device's copied cut cannot hide or delete the pending wildcard message.
  assertEquals(
    (await sync(second.accessToken, first.next_batch)).to_device,
    first.to_device,
  );
  assertEquals(
    (await sync(b.access_token!, first.next_batch)).to_device.events,
    [],
  );
  await send(a.access_token!, 'same', {
    [b.user_id]: { '*': { opaque: 'retry-must-not-send' } },
  });
  assertEquals((await sync(b.access_token!)).to_device.events, []);
  const third = await loginUser(theApp().tenant, {
    localpart: 'inbox-b',
    password: 'pw',
    deviceId: 'THIRD',
    refresh: false,
  });
  await send(a.access_token!, 'same', { [b.user_id]: { '*': { opaque: 2 } } });
  assertEquals((await sync(third.accessToken)).to_device.events, []);
  // Same textual transaction belongs to another sender, with independent receipt scope.
  await send(b.access_token!, 'same', {
    [b.user_id]: { [b.device_id]: { opaque: 3 }, missing: { ignored: true } },
  });
  assertEquals((await sync(b.access_token!)).to_device.events[0].content, {
    opaque: 3,
  });
});

suite.test('250 messages drain 100/100/50, forged known-head cut replays, older sync cannot rewind ack', async () => {
  const a = await suite.registerTestUser('batch-a', 'pw');
  const b = await suite.registerTestUser('batch-b', 'pw');
  const before = await sync(b.access_token!);
  for (let n = 0; n < 250; n++) {
    await send(a.access_token!, 'batch-' + n, {
      [b.user_id]: { [b.device_id]: { n } },
    });
  }
  const first = await sync(b.access_token!, before.next_batch);
  assertEquals(first.to_device.events.length, 100);
  const forged = first.next_batch.replace(/_m\d+/, '_m250').replace(
    /_k\d+/,
    '_k0',
  );
  const replay = await sync(b.access_token!, forged);
  assertEquals(replay.to_device, first.to_device);
  const second = await sync(b.access_token!, first.next_batch);
  assertEquals(second.to_device.events.length, 100);
  const third = await sync(b.access_token!, second.next_batch);
  assertEquals(third.to_device.events.length, 50);
  assertEquals(third.to_device.events[49].content.n, 249);
  assertEquals(
    (await sync(b.access_token!, third.next_batch)).to_device.events,
    [],
  );
  assertEquals(
    (await sync(b.access_token!, first.next_batch)).to_device.events,
    [],
  );
  await call(
    b.access_token!,
    'sync?since=s9007199254740992',
    undefined,
    'GET',
    400,
  );
  await call(
    b.access_token!,
    'sync?since=' +
      encodeURIComponent(third.next_batch.replace(/_m\d+/, '_m999999')),
    undefined,
    'GET',
    200,
  );
});

suite.test('inbox and key-pool mutations wake sync without room events', async () => {
  const a = await suite.registerTestUser('wake-a', 'pw');
  const b = await suite.registerTestUser('wake-b', 'pw');
  await call(b.access_token!, 'keys/upload', {
    one_time_keys: { 'curve25519:k': 'key' },
    fallback_keys: { 'curve25519:f': 'fallback' },
  });
  const before = await sync(b.access_token!);
  const started = Date.now();
  const pending = sync(b.access_token!, before.next_batch, 3000);
  await call(a.access_token!, 'keys/claim', {
    one_time_keys: { [b.user_id]: { [b.device_id]: 'curve25519' } },
  });
  const after = await pending;
  assert(
    Date.now() - started < 2500,
    'key claim must wake sync before timeout',
  );
  assertEquals(after.device_one_time_keys_count, {});
  assert(after.next_batch !== before.next_batch);
  const inboxWait = sync(b.access_token!, after.next_batch, 3000);
  const inboxStarted = Date.now();
  await send(a.access_token!, 'wake', {
    [b.user_id]: { [b.device_id]: { wake: true } },
  });
  assertEquals((await inboxWait).to_device.events.length, 1);
  assert(
    Date.now() - inboxStarted < 2500,
    'inbox send must wake sync before timeout',
  );
  const fallbackBefore = await sync(b.access_token!);
  const fallbackWait = sync(b.access_token!, fallbackBefore.next_batch, 3000);
  await call(a.access_token!, 'keys/claim', {
    one_time_keys: { [b.user_id]: { [b.device_id]: 'curve25519' } },
  });
  assertEquals((await fallbackWait).device_unused_fallback_key_types, []);
});

suite.test('configured queue overflow rejects atomically and device recreation cannot inherit queue or cuts', async () => {
  const a = await suite.registerTestUser('cap-a', 'pw');
  const b = await suite.registerTestUser('cap-b', 'pw');
  const limits = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxinboxmessages: 1 } });
    await send(a.access_token!, 'first', { [b.user_id]: { '*': { n: 1 } } });
    await send(a.access_token!, 'overflow', {
      [a.user_id]: { '*': { n: 2 } },
      [b.user_id]: { '*': { n: 2 } },
    }, 413);
    assertEquals((await sync(a.access_token!)).to_device.events, []);
    const issued = await sync(b.access_token!);
    await call(b.access_token!, 'logout', {});
    const replacement = await loginUser(theApp().tenant, {
      localpart: 'cap-b',
      password: 'pw',
      deviceId: b.device_id,
      refresh: false,
    });
    assertEquals(
      (await sync(replacement.accessToken, issued.next_batch)).to_device.events,
      [],
    );
    await send(a.access_token!, 'overflow', { [a.user_id]: { '*': { n: 3 } } });
    assertEquals((await sync(a.access_token!)).to_device.events[0].content, {
      n: 3,
    });
  } finally {
    setConfigForTests({ e2ee: limits });
  }
});
