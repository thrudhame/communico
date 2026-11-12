import { assert, assertEquals, assertThrows } from '@std/assert';
import { manifest } from '#tests/spec-contract.ts';
import {
  assertConsumptionInventory,
  assertConsumptionProofs,
  consumption,
  consumptionProofs,
  unconsumedParameters,
} from '#tests/spec-consumption.ts';
import { decodedField, decoderReads } from '#tests/spec-decoder.ts';

Deno.test('request inventory binds every exact request node and preserves every response contract', async () => {
  assertConsumptionInventory(consumption);
  const endpoints = JSON.parse(
    await Deno.readTextFile(
      new URL('fixtures/versions-endpoints.json', import.meta.url),
    ),
  ) as {
    file: string;
    method: string;
    path: string;
    status: string;
    routes: string[];
  }[];
  for (const row of consumption.operations) {
    const endpoint = endpoints.find((endpoint) =>
      endpoint.file + '#' + endpoint.method + ' ' + endpoint.path === row.id
    )!;
    assertEquals(
      [row.status, row.routes],
      [endpoint.status, endpoint.routes],
      row.id + ': stale exclusion or route',
    );
  }
  const bytes = await Deno.readFile(
    new URL('fixtures/spec-contracts-v1.16.json', import.meta.url),
  );
  const digest = [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)),
  ].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  assertEquals(
    consumption.manifestSha256,
    digest,
    'schema, default, enum or prose changed without consumption review',
  );
  assertEquals(
    consumption.operations.reduce((n, op) => n + op.request.length, 0),
    manifest.operations.reduce((n, op) => n + op.request.length, 0),
  );
  const paths = new Set([
    ...Object.values(consumption.bindings).flatMap((
      binding,
    ) => [binding.decoder, binding.owner]),
    ...consumption.operations.flatMap((op) =>
      op.request.flatMap((field) => field.decoders)
    ),
  ]);
  for (const path of paths) {
    assert(
      (await Deno.stat(
        new URL('../' + path.replaceAll('#', '%23'), import.meta.url),
      )).isFile,
      path,
    );
  }
});

Deno.test('request ledger rejects missing, duplicate, unclassified and stale response entries', () => {
  const fieldRow = consumption.operations.findIndex((op) =>
    op.request.length > 0
  );
  const responseRow = consumption.operations.findIndex((op) =>
    op.response.length > 0
  );
  const missing = structuredClone(consumption);
  missing.operations[fieldRow].request.pop();
  assertThrows(() => assertConsumptionInventory(missing));
  const duplicate = structuredClone(consumption);
  duplicate.operations[fieldRow].request.push(
    duplicate.operations[fieldRow].request[0],
  );
  assertThrows(() => assertConsumptionInventory(duplicate));
  const unclassified = structuredClone(consumption);
  unclassified.operations[fieldRow].request[0].binding = 'unreviewed';
  assertThrows(() => assertConsumptionInventory(unclassified));
  const response = structuredClone(consumption);
  response.operations[responseRow].response.pop();
  assertThrows(() => assertConsumptionInventory(response));
});

Deno.test('consumer proof gate requires exact successful testcase names in their owning suite', () => {
  const proofs = [{ suite: 'http-example', case: 'result changes & persists' }];
  const xml =
    '<testcase classname="file:///tests/http-example.test.ts" name="result changes &amp; persists"></testcase>';
  assertConsumptionProofs(xml, proofs);
  assertThrows(() =>
    assertConsumptionProofs(xml.replace('http-example', 'http-other'), proofs)
  );
  assertThrows(() =>
    assertConsumptionProofs(
      xml.replace('</testcase>', '<skipped/></testcase>'),
      proofs,
    )
  );
  assertThrows(() =>
    assertConsumptionProofs(
      xml.replace('</testcase>', '<failure>bad</failure></testcase>'),
      proofs,
    )
  );
  assertThrows(() =>
    assertConsumptionProofs(xml.replace('persists', 'persists maybe'), proofs)
  );
  assert(consumptionProofs().length > 50);
});

Deno.test('routed spec parameters are decoded or explicitly not applicable', () => {
  assertEquals(unconsumedParameters(), []);
});

Deno.test('decoder consumption does not inherit unread children from containers', () => {
  const reads = new Set(['body/application/json/filter/types/[]']);
  assert(decodedField('body/application/json/filter/types', reads));
  assert(!decodedField('body/application/json/filter/senders', reads));
  assert(!decodedField('query/server', reads));
  assert(
    decodedField(
      'body/application/json/content/*',
      new Set(['body/application/json/content/**']),
    ),
  );
  assert(
    !decodedField(
      'body/application/json/unread',
      new Set(['body/application/json/**']),
    ),
  );
});

Deno.test('decoder flow follows called owners but ignores unrelated names and imports', () => {
  const entry = 'tests/decoder-flow-entry.ts';
  const owner = 'tests/decoder-flow-owner.ts';
  const source = new Map([
    [
      entry,
      `import { decode, unrelated } from './decoder-flow-owner.ts';
      export default function(request) {
        const body = request.body.json();
        return decode(body.filter, request.query);
      }`,
    ],
    [
      owner,
      `export function decode(filter, query) {
        const alias = filter;
        return { types: alias.types, limit: query.get('limit') };
      }
      export function unrelated(body, query) {
        return [body.senders, query.get('server')];
      }`,
    ],
  ]);
  const reads = decoderReads(entry, source);
  assert(decodedField('body/application/json/filter/types', reads));
  assert(decodedField('query/limit', reads));
  assert(!decodedField('body/application/json/filter/senders', reads));
  assert(!decodedField('query/server', reads));
  source.set(owner, source.get(owner)!.replace('alias.types', 'alias.senders'));
  const changed = decoderReads(entry, source);
  assert(!decodedField('body/application/json/filter/types', changed));
  assert(decodedField('body/application/json/filter/senders', changed));
});

Deno.test('decoder flow follows the actual tenant argument binding', () => {
  const route =
    'api/endpoints/matrix/_matrix/client/v3/room_keys/version/post.ts';
  const binding = 'api/engine/tenant/index.ts';
  const source = Deno.readTextFileSync(
    new URL('../' + binding, import.meta.url),
  );
  const changed = source.replaceAll(
    /input,(\s+config\(\)\.e2ee)/g,
    'undefined,$1',
  );
  assert(changed !== source);
  assert(decodedField('body/application/json/auth_data', decoderReads(route)));
  assert(
    !decodedField(
      'body/application/json/auth_data',
      decoderReads(route, new Map([[binding, changed]])),
    ),
  );
});
