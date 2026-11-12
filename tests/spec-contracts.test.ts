import { assert, assertEquals } from '@std/assert';
import {
  assertSpecResponse,
  manifest,
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
