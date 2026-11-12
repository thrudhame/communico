import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { config, setConfigForTests } from '#engine/config.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP E5 encrypted key backup');
const algorithm = 'm.megolm_backup.v1.curve25519-aes-sha2';
const key = (
  ciphertext: string,
  verified = false,
  index = 20,
  forwarded = 2,
) => ({
  is_verified: verified,
  first_message_index: index,
  forwarded_count: forwarded,
  session_data: {
    ciphertext,
    mac: 'opaque',
    ephemeral: 'opaque',
    extension: ['kept'],
  },
});
async function request(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<Json> {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/room_keys/' + path, {
      method,
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(response.status, status, await response.clone().text());
  return await response.json();
}

suite.test('all granularities, isolation, opaque rooms and ordered replacement reach the HTTP consumer', async () => {
  const unauthenticated = await suite.matrix(
    new Request('http://x/_matrix/client/v3/room_keys/version'),
  );
  assertEquals(unauthenticated.status, 401);
  await unauthenticated.body?.cancel();
  const alice = await suite.registerTestUser('backup-a', 'pw');
  const bob = await suite.registerTestUser('backup-b', 'pw');
  const token = alice.access_token!;
  await request(token, 'GET', 'version', undefined, 404);
  await request(token, 'POST', 'version', {
    algorithm,
    auth_data: { public_key: 'opaque' },
  });
  const initial = await request(token, 'GET', 'version');
  assertEquals(initial, {
    version: '1',
    algorithm,
    auth_data: { public_key: 'opaque' },
    count: 0,
    etag: '0',
  });
  await request(bob.access_token!, 'GET', 'version/1', undefined, 404);
  await request(token, 'GET', 'keys', undefined, 400);
  const room = encodeURIComponent('!never-hosted:elsewhere.test');
  const one = `keys/${room}/s?version=1`;
  const old = key('first');
  const put = await request(token, 'PUT', one, old);
  assertEquals(put, { count: 1, etag: '1' });
  for (
    const candidate of [
      key('tie'),
      key('worse-index-better-forward', false, 21, 0),
      key('worse-verification', false, 100, 0),
    ]
  ) {
    assertEquals(await request(token, 'PUT', one, candidate), put);
    assertEquals(await request(token, 'GET', one), old);
  }
  const verified = key('verified-wins', true, 100, 100);
  await request(token, 'PUT', one, verified);
  await request(token, 'PUT', one, key('unverified-better-index', false, 0, 0));
  assertEquals(await request(token, 'GET', one), verified);
  const earlier = key('index-wins', true, 99, 200);
  await request(token, 'PUT', one, earlier);
  const fewer = key('forward-wins', true, 99, 199);
  await request(token, 'PUT', one, fewer);
  assertEquals(await request(token, 'GET', one), fewer);
  await request(token, 'PUT', `keys/${room}?version=1`, {
    sessions: { second: key('second') },
  });
  await request(token, 'PUT', 'keys?version=1', {
    rooms: {
      '__proto__': { sessions: {} },
      '!another:unknown': { sessions: { x: key('third') } },
    },
  });
  const all = await request(token, 'GET', 'keys?version=1');
  const rooms = all.rooms as Record<string, { sessions: Json }>;
  assertEquals(rooms['!never-hosted:elsewhere.test'].sessions, {
    s: fewer,
    second: key('second'),
  });
  assertEquals(rooms['!another:unknown'].sessions.x, key('third'));
  assertEquals(await request(token, 'GET', 'keys/absent?version=1'), {
    sessions: {},
  });
  await request(token, 'GET', 'keys/absent/missing?version=1', undefined, 404);
  const beforeDelete = await request(token, 'GET', 'version/1');
  await request(token, 'DELETE', one);
  const afterOne = await request(token, 'GET', 'version/1');
  assertEquals(afterOne.count, 2);
  assert(afterOne.etag !== beforeDelete.etag);
  assertEquals(await request(token, 'DELETE', one), {
    etag: afterOne.etag,
    count: 2,
  });
  await request(token, 'DELETE', `keys/${room}?version=1`);
  assertEquals((await request(token, 'GET', 'version/1')).count, 1);
  await request(token, 'DELETE', 'keys?version=1');
  assertEquals(await request(token, 'GET', 'keys?version=1'), { rooms: {} });
  await request(bob.access_token!, 'POST', 'version', {
    algorithm,
    auth_data: {},
  });
  assertEquals(await request(bob.access_token!, 'GET', 'keys?version=1'), {
    rooms: {},
  });
});

suite.test('version tombstones, numeric latest, immutable algorithm and metadata-only etag', async () => {
  const a = await suite.registerTestUser('backup-versions', 'pw');
  const token = a.access_token!;
  for (let i = 1; i <= 10; i++) {
    assertEquals(
      await request(token, 'POST', 'version', { algorithm, auth_data: { i } }),
      { version: String(i) },
    );
  }
  assertEquals((await request(token, 'GET', 'version')).version, '10');
  await request(token, 'PUT', 'keys/room/s?version=9', key('old'), 403).then(
    (error) => {
      assertEquals(error.errcode, 'M_WRONG_ROOM_KEYS_VERSION');
      assertEquals(error.current_version, '10');
    },
  );
  await request(token, 'PUT', 'keys/room/s?version=999', key('missing'), 404);
  await request(token, 'PUT', 'version/10', {
    algorithm: 'different',
    auth_data: {},
  }, 400);
  await request(token, 'PUT', 'version/10', {
    algorithm,
    version: '9',
    auth_data: {},
  }, 400);
  await request(token, 'PUT', 'version/10', {
    algorithm,
    version: '10',
    auth_data: { changed: true },
  });
  assertEquals(await request(token, 'GET', 'version/10'), {
    version: '10',
    algorithm,
    auth_data: { changed: true },
    count: 0,
    etag: '0',
  });
  await request(token, 'DELETE', 'version/10');
  await request(token, 'DELETE', 'version/10');
  await request(token, 'DELETE', 'version/unknown', undefined, 404);
  await request(token, 'GET', 'version/10', undefined, 404);
  assertEquals((await request(token, 'GET', 'version')).version, '9');
  await request(
    token,
    'PUT',
    'keys/room/s?version=9',
    key('historical-now-current'),
  );
  assertEquals(
    await request(token, 'POST', 'version', { algorithm, auth_data: {} }),
    { version: '11' },
  );
  assertEquals(
    ((await request(token, 'GET', 'keys/room/s?version=9'))
      .session_data as Json).ciphertext,
    'historical-now-current',
  );
  await request(token, 'DELETE', 'keys/room?version=9');
});

suite.test('validation and configured budgets reject atomically without changing etag or ciphertext', async () => {
  const a = await suite.registerTestUser('backup-limits', 'pw');
  const token = a.access_token!;
  await request(token, 'POST', 'version', { algorithm, auth_data: {} });
  await request(
    token,
    'POST',
    'version',
    { algorithm: '', auth_data: {} },
    400,
  );
  await request(token, 'POST', 'version', { algorithm, auth_data: [] }, 400);
  const valid = key('keep');
  for (
    const invalid of [key('invalid', false, -1), key('invalid', false, 1.5), {
      ...valid,
      is_verified: 'true',
    }, { ...valid, session_data: [] }]
  ) {
    await request(token, 'PUT', 'keys?version=1', {
      rooms: { room: { sessions: { valid, invalid } } },
    }, 400);
    assertEquals((await request(token, 'GET', 'version/1')).count, 0);
  }
  const before = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxkeys: 1 } });
    await request(token, 'PUT', 'keys/room?version=1', {
      sessions: { a: valid, b: valid },
    }, 413);
    setConfigForTests({ e2ee: { maxkeybytes: 50 } });
    await request(token, 'PUT', 'keys/room/s?version=1', valid, 413);
  } finally {
    setConfigForTests({ e2ee: before });
  }
  assertEquals((await request(token, 'GET', 'version/1')).etag, '0');
  const writes = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      request(
        token,
        'PUT',
        `keys/room/s?version=1`,
        key(String(i), false, 8 - i, i),
      )),
  );
  assertEquals(
    (await request(token, 'GET', 'keys/room/s?version=1')).first_message_index,
    1,
  );
  assertEquals(writes.at(-1)!.count, 1);
});

suite.test('batched accepted backups restore beyond individual upload count and byte limits', async () => {
  const a = await suite.registerTestUser('backup-restore', 'pw');
  const token = a.access_token!;
  const before = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxkeys: 1, maxrequestbytes: 512 } });
    await request(token, 'POST', 'version', { algorithm, auth_data: {} });
    const expected: Json = {};
    for (let i = 0; i < 4; i++) {
      const value = key(String(i) + 'x'.repeat(100));
      expected['s' + i] = value;
      await request(token, 'PUT', `keys/room/s${i}?version=1`, value);
    }
    assertEquals(await request(token, 'GET', 'keys/room?version=1'), {
      sessions: expected,
    });
    assertEquals(await request(token, 'GET', 'keys?version=1'), {
      rooms: { room: { sessions: expected } },
    });
    assertEquals((await request(token, 'GET', 'version/1')).count, 4);
    setConfigForTests({ e2ee: before });
    const large = await suite.registerTestUser('backup-default-restore', 'pw');
    await request(large.access_token!, 'POST', 'version', {
      algorithm,
      auth_data: {},
    });
    const sessions: Json = {};
    for (let batch = 0; batch < 2; batch++) {
      const upload: Json = {};
      for (let i = 0; i < 550; i++) {
        const id = 's' + (batch * 550 + i);
        upload[id] = sessions[id] = key(id + 'x'.repeat(1000));
      }
      await request(large.access_token!, 'PUT', 'keys/room?version=1', {
        sessions: upload,
      });
    }
    assertEquals(await request(large.access_token!, 'GET', 'keys?version=1'), {
      rooms: { room: { sessions } },
    });
  } finally {
    setConfigForTests({ e2ee: before });
  }
});

suite.test('restore byte admission is exact, atomic across granularities and released by deletion', async () => {
  const a = await suite.registerTestUser('backup-restore-bytes', 'pw');
  const token = a.access_token!;
  const before = { ...config().e2ee };
  const room = 'r"\\\nÄ';
  const otherRoom = 'other"\\\n';
  const first = key('x'.repeat(200));
  const second = key('y'.repeat(200));
  const expected = {
    rooms: {
      [room]: { sessions: { 's"\\\n': first, second } },
      [otherRoom]: { sessions: { s: second } },
    },
  };
  const limit = new TextEncoder().encode(JSON.stringify(expected)).byteLength;
  try {
    setConfigForTests({ e2ee: { maxbackupbytes: limit } });
    await request(token, 'POST', 'version', { algorithm, auth_data: {} });
    await request(token, 'PUT', 'keys?version=1', expected);
    assertEquals(await request(token, 'GET', 'keys?version=1'), expected);
    const original = await request(token, 'GET', 'version/1');
    await request(token, 'PUT', 'keys/third?version=1', {
      sessions: { s: first },
    }, 413);
    await request(
      token,
      'PUT',
      `keys/${encodeURIComponent(room)}/${
        encodeURIComponent('s"\\\n')
      }?version=1`,
      key('z'.repeat(202), true),
      413,
    );
    await request(token, 'PUT', 'keys?version=1', {
      rooms: { third: { sessions: { a: first, b: second } } },
    }, 413);
    assertEquals(await request(token, 'GET', 'version/1'), original);
    assertEquals(await request(token, 'GET', 'keys?version=1'), expected);
    await request(token, 'PUT', 'version/1', {
      algorithm,
      auth_data: { oversized: 'x'.repeat(limit) },
    }, 413);
    assertEquals(await request(token, 'GET', 'version/1'), original);
    await request(
      token,
      'DELETE',
      `keys/${encodeURIComponent(room)}?version=1`,
    );
    await request(token, 'PUT', 'keys/third/s?version=1', first);
    assertEquals(await request(token, 'GET', 'keys?version=1'), {
      rooms: {
        [otherRoom]: expected.rooms[otherRoom],
        third: { sessions: { s: first } },
      },
    });
  } finally {
    setConfigForTests({ e2ee: before });
  }
});
