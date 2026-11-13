import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from '@std/assert';
import { inspect } from 'node:util';
import { decodeJson, objectOf } from '#engine/net/json.ts';
import {
  networkOperation,
  protocol,
  upstreamCategory,
  UpstreamError,
} from '#engine/net/upstream-error.ts';
import { http1Wire } from '#engine/net/http1.ts';
import { FederationHttpError } from '#engine/federation/client.ts';

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

Deno.test('upstream diagnostics retain a private cause without printing its input', () => {
  const secret = 'https://private.invalid/file?access_token=synthetic-secret';
  const cause = new SyntaxError(`Unexpected token in "${secret}"`);
  const error = new UpstreamError('protocol', {
    phase: 'json',
    reason: 'invalid JSON response',
    remoteStatus: 200,
    cause,
  });
  assertEquals(error.cause, cause);
  for (
    const diagnostic of [
      Deno.inspect(error),
      inspect(error),
      JSON.stringify(error),
      JSON.stringify(error.context),
    ]
  ) {
    assert(!diagnostic.includes(secret), diagnostic);
    assert(!diagnostic.includes('synthetic-secret'), diagnostic);
    assert(diagnostic.includes('json'), diagnostic);
  }
});

Deno.test('JSON decoder causes cannot leak response snippets through normal diagnostics', () => {
  let error: unknown;
  try {
    decodeJson(
      new TextEncoder().encode(
        '{"url":"https://private.invalid/?secret=synthetic-secret",bad}',
      ),
      'application/json',
    );
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof UpstreamError);
  assert(error.cause instanceof SyntaxError);
  for (
    const diagnostic of [
      Deno.inspect(error),
      inspect(error),
      JSON.stringify(error),
    ]
  ) {
    assert(!diagnostic.includes('synthetic-secret'), diagnostic);
    assert(diagnostic.includes('protocol'), diagnostic);
  }
});

Deno.test('upstream diagnostics: real console output is safe and completed HTTP keeps its response body', async () => {
  const source = import.meta.resolve('#engine/net/upstream-error.ts');
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      'eval',
      `import { UpstreamError } from ${JSON.stringify(source)};
      const cause = new Error('https://private.invalid/?secret=synthetic-secret');
      const error = new UpstreamError('protocol', {phase:'json',reason:'invalid response',cause});
      console.error(error); console.log(JSON.stringify(error));`,
    ],
    stdout: 'piped',
    stderr: 'piped',
  });
  const output = await child.output();
  assertEquals(output.code, 0);
  for (const bytes of [output.stdout, output.stderr]) {
    const text = new TextDecoder().decode(bytes);
    assert(!text.includes('synthetic-secret'), text);
    assert(text.includes('protocol'), text);
  }
  const http = new FederationHttpError(
    404,
    true,
    'M_UNRECOGNIZED',
    'synthetic-secret',
  );
  assertEquals(upstreamCategory(http), 'http');
  assertEquals(http.status, 404);
  assertEquals(http.responseBody(), {
    errcode: 'M_UNRECOGNIZED',
    error: 'synthetic-secret',
  });
  for (
    const text of [
      Deno.inspect(http),
      inspect(http),
      JSON.stringify(http),
      String(http),
    ]
  ) {
    assert(!text.includes('synthetic-secret'), text);
    assert(text.includes('404'), text);
  }
});
