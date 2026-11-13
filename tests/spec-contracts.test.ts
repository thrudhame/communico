import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import {
  assertSpecHttpResponse,
  assertSpecResponse,
  manifest,
  responseCompatibility,
  schemaErrors,
} from '#tests/spec-contract.ts';

Deno.test('pinned OpenAPI operation identities match the complete version inventory exactly', async () => {
  const endpoints = JSON.parse(
    await Deno.readTextFile(
      new URL('fixtures/versions-endpoints.json', import.meta.url),
    ),
  ) as { file: string; method: string; path: string }[];
  assertEquals(manifest.schema, 1);
  assertEquals(manifest.generatorVersion, 1);
  assertEquals(manifest.specTag, 'v1.16');
  assertEquals(manifest.specCommit, '81a864545f7d948a881f5227700e5312c64f506e');
  const expected = endpoints.map((operation) =>
    operation.file + '#' + operation.method + ' ' + operation.path
  ).sort();
  const actual = manifest.operations.map((operation) => operation.id).sort();
  assertEquals(actual, expected);
  assertEquals(
    new Set(actual).size,
    actual.length,
    'duplicate operations must retain distinct source identities',
  );
  for (const operation of manifest.operations) {
    for (const field of [...operation.request, ...operation.response]) {
      assert(
        manifest.schemas[field.source] !== undefined,
        operation.id + ': missing field schema ' + field.source,
      );
      assert(
        manifest.sources[field.source.split('#')[0]] !== undefined,
        operation.id + ': missing source provenance',
      );
    }
  }
});

Deno.test('schema guard enforces required children only when their optional parent exists', () => {
  const schema = {
    type: 'object',
    properties: {
      optional: {
        type: 'object',
        required: ['needed'],
        properties: { needed: { type: 'string' } },
      },
    },
  };
  assertEquals(schemaErrors({}, schema), []);
  assertEquals(schemaErrors({ optional: { needed: '' } }, schema), []);
  assert(
    schemaErrors({ optional: {} }, schema).some((error) =>
      error.includes('needed')
    ),
  );
  assert(
    schemaErrors({ optional: { needed: 1 } }, schema).some((error) =>
      error.includes('string')
    ),
  );
  assertEquals(
    schemaErrors({ optional: { needed: '', 'org.example': true } }, schema),
    [],
  );
});

Deno.test('schema guard retains tagged enum, array, composition and map requirements', () => {
  assert(schemaErrors('bad', { enum: ['good'] }).length > 0);
  assert(schemaErrors(0.5, { type: 'integer' }).length > 0);
  assert(
    schemaErrors([{}], {
      type: 'array',
      items: { type: 'object', required: ['value'] },
    }).length > 0,
  );
  assertEquals(schemaErrors(null, { type: ['string', 'null'] }), []);
  assertEquals(
    schemaErrors('s', { anyOf: [{ type: 'integer' }, { type: 'string' }] }),
    [],
  );
  assert(
    schemaErrors(true, { anyOf: [{ type: 'integer' }, { type: 'string' }] })
      .length > 0,
  );
  assert(
    schemaErrors(1, { oneOf: [{ type: 'integer' }, { type: 'number' }] })
      .length > 0,
  );
  assert(
    schemaErrors({ arbitrary: 3 }, {
      type: 'object',
      additionalProperties: { type: 'string' },
    }).length > 0,
  );
  assertEquals(
    schemaErrors({ arbitrary: 'ok' }, {
      type: 'object',
      additionalProperties: { type: 'string' },
    }),
    [],
  );
});

Deno.test('tagged public directory responses require real entry fields without requiring optional metadata', () => {
  assertSpecResponse('GET', '/_matrix/client/v3/publicRooms', 200, {
    chunk: [],
  });
  assertSpecResponse('POST', '/_matrix/federation/v1/publicRooms', 200, {
    chunk: [{
      room_id: '!remote:example.test',
      num_joined_members: 0,
      world_readable: false,
      guest_can_join: false,
    }],
  });
  const operation = manifest.operations.find((operation) =>
    operation.method === 'GET' &&
    operation.path === '/_matrix/client/v3/publicRooms'
  )!;
  const root = operation.response.find((field) =>
    field.field === 'response/200/application/json'
  )!;
  assert(
    schemaErrors({}, { $ref: root.source }).some((error) =>
      error.includes('chunk')
    ),
  );
  assert(
    schemaErrors({ chunk: [{}] }, { $ref: root.source }).some((error) =>
      error.includes('room_id')
    ),
  );
  assert(
    schemaErrors({ chunk: [], next_batch: 3 }, { $ref: root.source }).length >
      0,
  );
});

Deno.test('tagged federation profile prose permits null only for unset profile fields', () => {
  assertSpecResponse('GET', '/_matrix/federation/v1/query/profile', 200, {
    displayname: null,
  });
  assertSpecResponse('GET', '/_matrix/federation/v1/query/profile', 200, {
    avatar_url: null,
  });
  assertSpecResponse('GET', '/_matrix/federation/v1/query/profile', 200, {});
});

Deno.test('HTTP response guard rejects undeclared successful statuses', async () => {
  const request = new Request('http://x/_matrix/client/v3/publicRooms');
  await assertRejects(() =>
    assertSpecHttpResponse(request, Response.json({}, { status: 201 }))
  );
  await assertSpecHttpResponse(request, Response.json({ chunk: [] }));
  await assertSpecHttpResponse(
    new Request('http://x/_matrix/federation/v1/query/custom'),
    new Response(null, { status: 200 }),
  );
});

Deno.test('explicit Synapse response compatibility is scoped and never changes pinned schemas', () => {
  const path = '/_matrix/client/v3/rooms/{roomId}/joined_members';
  const operation = manifest.operations.find((op) => op.path === path)!;
  const root = operation.response.find((f) =>
    f.field === 'response/200/application/json'
  )!;
  const value = {
    joined: {
      '@member:example.test': { display_name: null, avatar_url: null },
    },
  };
  assert(schemaErrors(value, { $ref: root.source }).length > 0);
  assertSpecResponse('GET', path, 200, value);
  assertThrows(() =>
    assertSpecResponse('GET', path, 200, {
      joined: { '@member:example.test': { avatar_url: false } },
    })
  );
  assertEquals(Object.keys(responseCompatibility).sort(), [
    'data/api/client-server/rooms.yaml#GET /_matrix/client/v3/rooms/{roomId}/joined_members',
    'data/api/client-server/search.yaml#POST /_matrix/client/v3/search',
  ]);
  for (const [id, exception] of Object.entries(responseCompatibility)) {
    assert(manifest.operations.some((op) => op.id === id));
    assert(exception.reason.includes('Synapse'));
    assert(exception.reason.includes('Complement'));
  }
});

Deno.test('state response format selects its tagged content or event contract before validating', async () => {
  const path = 'http://x/_matrix/client/v3/rooms/room/state/m.room.name/name';
  await assertSpecHttpResponse(new Request(path), Response.json({}));
  await assertSpecHttpResponse(
    new Request(path + '?format=content'),
    Response.json({}),
  );
  await assertRejects(() =>
    assertSpecHttpResponse(
      new Request(path + '?format=event'),
      Response.json({}),
    )
  );
  await assertSpecHttpResponse(
    new Request(path + '?format=event'),
    Response.json({
      event_id: '$event',
      type: 'm.room.name',
      state_key: 'name',
      sender: '@sender:example.test',
      room_id: '!room:example.test',
      origin_server_ts: 0,
      content: {},
    }),
  );
});

Deno.test('send response guard selects delayed scheduling without weakening ordinary writes', async () => {
  for (
    const suffix of [
      'state/test',
      'state/test/',
      'state/test/key',
      'send/test/txn',
    ]
  ) {
    const path = 'http://x/_matrix/client/v3/rooms/room/' + suffix;
    const request = (query = '') =>
      new Request(path + query, { method: 'PUT' });
    await assertSpecHttpResponse(
      request(),
      Response.json({ event_id: '$event' }),
    );
    await assertRejects(() =>
      assertSpecHttpResponse(request(), Response.json({ delay_id: 'schedule' }))
    );
    for (const delay of ['0', '60000']) {
      const delayed = () => request('?org.matrix.msc4140.delay=' + delay);
      await assertSpecHttpResponse(
        delayed(),
        Response.json({ delay_id: 'schedule' }),
      );
      for (
        const value of [{}, { delay_id: 1 }, { delay_id: '' }, {
          event_id: '$event',
        }, { delay_id: 'schedule', event_id: '$event' }]
      ) {
        await assertRejects(() =>
          assertSpecHttpResponse(delayed(), Response.json(value))
        );
      }
    }
  }
  await assertRejects(() =>
    assertSpecHttpResponse(
      new Request(
        'http://x/_matrix/client/v3/createRoom?org.matrix.msc4140.delay=0',
        { method: 'POST' },
      ),
      Response.json({ delay_id: 'schedule' }),
    )
  );
});

Deno.test('v2 invite response follows the room event format without inventing origin', () => {
  const path = '/_matrix/federation/v2/invite/{roomId}/{eventId}';
  const event = {
    type: 'm.room.member',
    state_key: '@member:example.test',
    sender: '@sender:remote.test',
    origin_server_ts: 1,
    content: { membership: 'invite' },
  };
  assertSpecResponse('PUT', path, 200, { event });
  assertSpecResponse('PUT', path, 200, {
    event: { ...event, origin: 'remote.test' },
  });
  assertThrows(() =>
    assertSpecResponse('PUT', path, 200, { event: { ...event, origin: 1 } })
  );
  for (
    const key of ['sender', 'state_key', 'origin_server_ts', 'type', 'content']
  ) {
    const missing: Record<string, unknown> = { ...event };
    delete missing[key];
    assertThrows(() =>
      assertSpecResponse('PUT', path, 200, { event: missing })
    );
  }
});

Deno.test('TURN response guard permits only the empty unconfigured branch or complete configured credentials', () => {
  const previous = config().turn;
  const check = (value: unknown) =>
    assertSpecResponse('GET', '/_matrix/client/v3/voip/turnServer', 200, value);
  try {
    setConfigForTests({
      turn: { uris: [], ttl: 0, secret: '', username: '', password: '' },
    });
    check({});
    assertThrows(() => check({ username: 'partial' }));
    setConfigForTests({
      turn: {
        uris: ['turn:example.test'],
        ttl: 60,
        username: 'user',
        password: 'password',
      },
    });
    assertThrows(() => check({}));
    assertThrows(() => check({ username: 'user' }));
    check({
      username: 'user',
      password: 'password',
      ttl: 60,
      uris: ['turn:example.test'],
    });
    setConfigForTests({
      turn: {
        uris: ['turn:example.test'],
        ttl: 60,
        username: '',
        password: '',
        secret: 'secret',
      },
    });
    assertThrows(() => check({}));
    check({
      username: 'user',
      password: 'password',
      ttl: 60,
      uris: ['turn:example.test'],
    });
  } finally {
    setConfigForTests({ turn: previous });
  }
});
