import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { config, setConfigForTests } from '#engine/config.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP E1 keys');
async function post(
  token: string,
  path: string,
  body: unknown,
  status = 200,
): Promise<Json> {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/keys/' + path, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: JSON.stringify(body),
    }),
  );
  assertEquals(response.status, status, await response.clone().text());
  return await response.json();
}
const otk = (key: string) => ({ key, signatures: {} });

suite.test('response budget failure rolls back every consuming key claim', async () => {
  const a = await suite.registerTestUser('budget-a', 'pw');
  const b = await suite.registerTestUser('budget-b', 'pw');
  for (const user of [a, b]) {
    await post(user.access_token!, 'upload', {
      one_time_keys: { 'curve25519:large': 'x'.repeat(180) },
    });
  }
  const before = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxrequestbytes: 250 } });
    await post(a.access_token!, 'claim', {
      one_time_keys: {
        [a.user_id]: { [a.device_id]: 'curve25519' },
        [b.user_id]: { [b.device_id]: 'curve25519' },
      },
    }, 413);
  } finally {
    setConfigForTests({ e2ee: before });
  }
  for (const user of [a, b]) {
    assertEquals(
      (await post(user.access_token!, 'upload', {})).one_time_key_counts,
      { curve25519: 1 },
    );
  }
});

suite.test('upload -> another user queries exact signed material and display metadata', async () => {
  const a = await suite.registerTestUser('keys-a', 'pw');
  const b = await suite.registerTestUser('keys-b', 'pw');
  const keys = {
    user_id: a.user_id,
    device_id: a.device_id,
    algorithms: ['m.olm.v1.curve25519-aes-sha2'],
    keys: {
      ['ed25519:' + a.device_id]: 'public',
      ['curve25519:' + a.device_id]: 'curve',
    },
    signatures: {},
    custom: { retained: true },
  };
  assertEquals(
    await post(a.access_token!, 'upload', {
      device_keys: keys,
      one_time_keys: { 'signed_curve25519:z': otk('first') },
    }),
    { one_time_key_counts: { signed_curve25519: 1 } },
  );
  const queried = await post(b.access_token!, 'query', {
    device_keys: { [a.user_id]: [] },
  });
  assertEquals(
    ((queried.device_keys as Json)[a.user_id] as Json)[a.device_id],
    { ...keys, unsigned: { device_display_name: 'keys-a' } },
  );
  assertEquals(
    (await post(b.access_token!, 'query', {
      device_keys: { [a.user_id]: ['missing'] },
    })).device_keys,
    { [a.user_id]: {} },
  );
  await post(a.access_token!, 'upload', {
    device_keys: { ...keys, user_id: b.user_id },
  }, 400);
  await post(a.access_token!, 'upload', {
    device_keys: { user_id: a.user_id, device_id: a.device_id },
  }, 400);
  await post(
    b.access_token!,
    'query',
    { device_keys: { [a.user_id]: {} } },
    400,
  );
});

suite.test('overlap/conflict atomicity, FIFO, concurrent consuming claims and fallback retry', async () => {
  const a = await suite.registerTestUser('pool-a', 'pw');
  const token = a.access_token!;
  const claim = () =>
    post(token, 'claim', {
      one_time_keys: { [a.user_id]: { [a.device_id]: 'signed_curve25519' } },
    });
  await post(token, 'upload', {
    one_time_keys: { 'signed_curve25519:z': otk('first') },
    fallback_keys: {
      'signed_curve25519:f': { ...otk('fallback'), fallback: true },
    },
  });
  const result = await post(token, 'upload', {
    one_time_keys: {
      'signed_curve25519:z': otk('first'),
      'signed_curve25519:a': otk('second'),
    },
  });
  assertEquals(result.one_time_key_counts, { signed_curve25519: 2 });
  await post(token, 'upload', {
    one_time_keys: {
      'signed_curve25519:new': otk('must-rollback'),
      'signed_curve25519:z': otk('conflict'),
    },
  }, 400);
  assertEquals((await post(token, 'upload', {})).one_time_key_counts, {
    signed_curve25519: 2,
  });
  const first = await claim();
  assertEquals(
    ((first.one_time_keys as Json)[a.user_id] as Json)[a.device_id],
    { 'signed_curve25519:z': otk('first') },
  );
  const next = await Promise.all([claim(), claim()]);
  const ids = next.map((r) =>
    Object.keys(
      ((r.one_time_keys as Json)[a.user_id] as Json)[a.device_id] as Json,
    )[0]
  ).sort();
  assertEquals(ids, ['signed_curve25519:a', 'signed_curve25519:f']);
  const fallback = await claim();
  assertEquals(
    ((fallback.one_time_keys as Json)[a.user_id] as Json)[a.device_id],
    { 'signed_curve25519:f': { ...otk('fallback'), fallback: true } },
  );
  await post(token, 'upload', {
    fallback_keys: {
      'signed_curve25519:f': { ...otk('fallback'), fallback: true },
    },
  });
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync?timeout=0', {
      headers: { Authorization: 'Bearer ' + token },
    }),
  );
  assertEquals(response.status, 200);
  const sync = await response.json();
  assertEquals(sync.device_one_time_keys_count, {});
  assertEquals(sync.device_unused_fallback_key_types, []);
  await post(token, 'upload', {
    fallback_keys: {
      'signed_curve25519:g': { ...otk('fresh'), fallback: true },
    },
  });
  const response2 = await suite.matrix(
    new Request('http://x/_matrix/client/v3/sync?timeout=0', {
      headers: { Authorization: 'Bearer ' + token },
    }),
  );
  const sync2 = await response2.json();
  assertEquals(sync2.device_unused_fallback_key_types, ['signed_curve25519']);
});

suite.test('deletion removes public keys and pools before textual ID reuse', async () => {
  const a = await suite.registerTestUser('delete-keys', 'pw');
  const token = a.access_token!;
  const keys = {
    user_id: a.user_id,
    device_id: a.device_id,
    algorithms: [],
    keys: {},
    signatures: {},
  };
  await post(token, 'upload', {
    device_keys: keys,
    one_time_keys: { 'curve25519:old': 'old' },
  });
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/logout', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token },
      body: '{}',
    }),
  );
  assertEquals(response.status, 200);
  const observer = await suite.registerTestUser('delete-observer', 'pw');
  assertEquals(
    (await post(observer.access_token!, 'query', {
      device_keys: { [a.user_id]: [] },
    })).device_keys,
    { [a.user_id]: {} },
  );
  assertEquals(
    (await post(observer.access_token!, 'claim', {
      one_time_keys: { [a.user_id]: { [a.device_id]: 'curve25519' } },
    })).one_time_keys,
    {},
  );
  assert(a.device_id.length > 0);
});
