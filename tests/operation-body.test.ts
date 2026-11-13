import { assert, assertEquals, assertThrows } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  decodeOperationBody,
  operationBodies,
  operationBodyPolicies,
} from '#engine/operation-body.ts';
import { manifest, schemaErrors } from '#tests/spec-contract.ts';

const empty = new Uint8Array();
Deno.test('Matrix adapters cannot bypass the shared operation body decoder', async () => {
  const walk = async (dir: URL): Promise<void> => {
    for await (const entry of Deno.readDir(dir)) {
      // Route directory names are filesystem segments, not URL fragments/query.
      const path = new URL(
        encodeURIComponent(entry.name) + (entry.isDirectory ? '/' : ''),
        dir,
      );
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith('.ts')) {
        const source = await Deno.readTextFile(path);
        assert(!source.includes('@pathfinder/pathfinder/body'), path.pathname);
        assert(!/\.body\.(?:json|text|bytes)\s*\(/.test(source), path.pathname);
      }
    }
  };
  await walk(new URL('../api/endpoints/matrix/_matrix/', import.meta.url));
});

Deno.test('every pinned operation retains its requestBody required flag and empty-object contract', () => {
  assertEquals(operationBodies.specCommit, manifest.specCommit);
  const expectedIds: string[] = [];
  for (const operation of manifest.operations) {
    const body = operation.request.find((field) =>
      field.field === 'body/application/json'
    );
    const rows = operationBodies.operations.filter((row) =>
      row.id === operation.id
    );
    if (body === undefined) {
      assertEquals(rows, []);
      continue; // No JSON body; raw media keeps its streaming owner.
    }
    expectedIds.push(operation.id);
    assertEquals(rows.length, 1, operation.id);
    const row = rows[0];
    assertEquals(row.required, body.required, operation.id);
    const acceptsEmpty = schemaErrors({}, { $ref: body.source }).length === 0;
    assertEquals(row.emptyObject, acceptsEmpty, operation.id);
    const path = operation.path.replace(/\{[^}]+\}/g, 'value');
    assert(
      operationBodyPolicies(operation.method, path).some((p) =>
        p.id === operation.id
      ),
    );
    if (body.required && !acceptsEmpty) {
      assertThrows(
        () => decodeOperationBody(empty, operation.method, path),
        MatrixError,
      );
    } else {
      assertEquals(decodeOperationBody(empty, operation.method, path), {});
    }
  }
  assertEquals(
    operationBodies.operations.map((row) => row.id).sort(),
    expectedIds.sort(),
  );
  assertEquals(manifest.operations.length, 197);
});

Deno.test('omission never relaxes malformed JSON, required fields or non-null field values', () => {
  const path = '/_matrix/client/v3/rooms/room/join';
  assertEquals(decodeOperationBody(empty, 'POST', path), {});
  for (const text of [' ', '{', 'null', '[]', 'false']) {
    assertThrows(
      () => decodeOperationBody(new TextEncoder().encode(text), 'POST', path),
      MatrixError,
    );
  }
  assertThrows(
    () => decodeOperationBody(new Uint8Array([0xff]), 'POST', path),
    MatrixError,
  );
  assertEquals(
    decodeOperationBody(
      new TextEncoder().encode('{"reason":null,"extension":false}'),
      'POST',
      path,
    ),
    { reason: null, extension: false },
  );
  // Known fields remain unchanged for their operation-specific validator.
  assertThrows(
    () => decodeOperationBody(empty, 'POST', '/_matrix/client/v3/login'),
    MatrixError,
  );
});
