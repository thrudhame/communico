import {
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import {
  networkOperation,
  protocol,
  upstreamCategory,
  UpstreamError,
} from '#engine/net/upstream-error.ts';
import { decodeJson, objectOf } from '#engine/net/json.ts';
import { http1Wire } from '#engine/net/http1.ts';

const enc = new TextEncoder();
Deno.test('upstream taxonomy: transport primitives only, local failures and cancellation retain cause', async () => {
  const local = new Error('disk full');
  assertEquals(upstreamCategory(local), 'local');
  const ac = new AbortController();
  ac.abort(local);
  assertStrictEquals(
    await networkOperation('read', ac.signal, () => Promise.resolve(1)).catch(
      (e) => e,
    ),
    local,
  );
  assertEquals(upstreamCategory(local, ac.signal), 'cancellation');
  const socket = new Error('socket reset');
  const result = await assertRejects(
    () => networkOperation('read', undefined, () => Promise.reject(socket)),
    UpstreamError,
  );
  assertEquals(result.category, 'transport');
  assertStrictEquals(result.cause, socket);
  const bad = assertThrows(
    () => protocol('mime', 'invalid envelope'),
    UpstreamError,
  );
  assertEquals(bad.category, 'protocol');
});
Deno.test('upstream JSON: fatal UTF8, JSON media type, legal whitespace and endpoint root', () => {
  assertEquals(
    decodeJson(
      enc.encode(' \r\n {"extension":true}\t'),
      'Application/JSON; charset="utf-8"; x=extra',
    ),
    { extension: true },
  );
  for (
    const bytes of [
      new Uint8Array([123, 34, 97, 34, 58, 34, 255, 34, 125]),
      enc.encode(''),
      enc.encode(' '),
    ]
  ) {
    assertEquals(
      assertThrows(() => decodeJson(bytes, 'application/json'), UpstreamError)
        .category,
      'protocol',
    );
  }
  assertThrows(() => decodeJson(enc.encode('{}'), 'text/plain'), UpstreamError);
  for (const value of [null, [], false, 1, 'x']) {
    assertThrows(() => objectOf(value), UpstreamError);
  }
});
Deno.test('upstream HTTP: consumer failures are not connection failures, even through content decoding', async () => {
  for (const compress of [false, true]) {
    let bytes = enc.encode('abc');
    if (compress) {
      bytes = new Uint8Array(
        await new Response(
          new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
        ).arrayBuffer(),
      );
    }
    const head = enc.encode(
      `HTTP/1.1 200 OK\r\nContent-Length: ${bytes.length}\r\n${
        compress ? 'Content-Encoding: gzip\r\n' : ''
      }\r\n`,
    );
    const raw = Uint8Array.from([head, bytes].flatMap((c) => [...c]));
    let at = 0;
    const disk = new Error('disk full');
    const outcome = await http1Wire({
      read(p) {
        const n = Math.min(p.length, raw.length - at);
        p.set(raw.subarray(at, at + n));
        at += n;
        return Promise.resolve(n || null);
      },
      write(p) {
        return Promise.resolve(p.length);
      },
      close() {},
    }, {
      method: 'GET',
      path: '/',
      hostHeader: 'peer',
      headers: {},
      body: null,
      maxBytes: 1000,
      sink: () =>
        new WritableStream({
          write() {
            throw disk;
          },
        }),
    }).catch((e) => e);
    assertStrictEquals(outcome, disk);
  }
});
