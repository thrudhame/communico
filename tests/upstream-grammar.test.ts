// Independent wire grammar tests, not roundtrips through our own producers.
import { assertEquals, assertRejects } from '@std/assert';
import { http1Wire } from '#engine/net/http1.ts';
import { mediaMultipart } from '#engine/media/multipart.ts';

const enc = new TextEncoder();
function connection(bytes: Uint8Array, split: number) {
  let at = 0;
  return {
    read(p: Uint8Array) {
      if (at === bytes.length) return Promise.resolve(null);
      const n = Math.min(split, p.length, bytes.length - at);
      p.set(bytes.subarray(at, at + n));
      at += n;
      return Promise.resolve(n);
    },
    write(p: Uint8Array) {
      return Promise.resolve(p.length);
    },
    close() {},
  };
}
const opts = {
  method: 'GET',
  path: '/',
  hostHeader: 'peer',
  headers: {},
  body: null,
  maxBytes: 100000,
};

Deno.test('external HTTP: informational heads precede final response, valid chunk extensions/trailers', async () => {
  const wire = 'HTTP/1.1 103 Early Hints\r\nLink: </a>\r\n\r\n' +
    'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '3 \t; name = "a;\\"b"\r\nabc\r\n0\r\nX-Note:\t fine \t\r\n\r\n';
  for (const split of [1, 7, 65536]) {
    const response = await http1Wire(connection(enc.encode(wire), split), opts);
    assertEquals(response.status, 200);
    assertEquals(response.body, enc.encode('abc'));
  }
});

Deno.test('external HTTP: invalid head/extension/trailer grammar is not accepted', async () => {
  for (
    const raw of [
      'HTTP/1.1 999 Nope\r\nContent-Length: 0\r\n\r\n',
      'HTTP/1.1 200 OK\r\nContent-Length : 0\r\n\r\n',
      'HTTP/1.1 200 OK\r\nX: x\u0001y\r\nContent-Length: 0\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1; x="open\r\nx\r\n0\r\n\r\n',
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX: a\u0001b\r\n\r\n',
    ]
  ) await assertRejects(() => http1Wire(connection(enc.encode(raw), 1), opts));
});

Deno.test('external HTTP: legal tiny chunks have no cumulative framing quota', async () => {
  const raw = 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n' +
    '1\r\nx\r\n'.repeat(14000) + '0\r\n\r\n';
  const response = await http1Wire(connection(enc.encode(raw), 4096), opts);
  assertEquals(response.body, enc.encode('x'.repeat(14000)));
});

Deno.test('external HTTP: gzip, deflate and br are decoded once with decoded limits', async () => {
  for (
    const [coding, format] of [['gzip', 'gzip'], ['deflate', 'deflate'], [
      'br',
      'brotli',
    ]] as const
  ) {
    const source = enc.encode('compressed representation '.repeat(200));
    const compressed = new Uint8Array(
      await new Response(
        new Blob([source]).stream().pipeThrough(new CompressionStream(format)),
      ).arrayBuffer(),
    );
    const head = enc.encode(
      `HTTP/1.1 200 OK\r\nContent-Encoding: ${coding}\r\nContent-Length: ${compressed.length}\r\n\r\n`,
    );
    const raw = Uint8Array.from([head, compressed].flatMap((c) => [...c]));
    const response = await http1Wire(connection(raw, 7), opts);
    assertEquals(response.body, source);
    assertEquals(response.headers.get('content-encoding'), null);
    await assertRejects(() =>
      http1Wire(connection(raw, 7), { ...opts, maxBytes: source.length - 1 })
    );
  }
  for (const coding of ['unknown', 'gzip']) {
    const error = await assertRejects(() =>
      http1Wire(
        connection(
          enc.encode(
            `HTTP/1.1 200 OK\r\nContent-Encoding: ${coding}\r\nContent-Length: 3\r\n\r\nabc`,
          ),
          1,
        ),
        opts,
      )
    );
    assertEquals((error as Error & { category: string }).category, 'protocol');
  }
});

async function parse(body: Uint8Array, contentType: string, split: number) {
  const chunks: Uint8Array[] = [];
  let closed = false;
  const parser = mediaMultipart(
    contentType,
    new WritableStream({
      write(bytes) {
        chunks.push(bytes.slice());
      },
      close() {
        closed = true;
      },
    }),
    100000,
  );
  const writer = parser.stream.getWriter();
  for (let at = 0; at < body.length; at += split) {
    await writer.write(body.subarray(at, at + split));
  }
  await writer.close();
  assertEquals(closed, true);
  return {
    ...parser.result,
    bytes: Uint8Array.from(chunks.flatMap((c) => [...c])),
  };
}

Deno.test('external MIME: preamble/epilogue, padding, parameters, folding and empty header block', async () => {
  const raw =
    'ignored preamble\r\n--test \t\r\nContent-Type: application/json;\r\n charset="utf-8"\r\nX-Note: a\r\nX-Note: b\r\n\r\n{}' +
    '\r\n--test\t\r\n\r\n\u0000abc\r\n--test-- \t\r\nignored epilogue';
  for (const split of [1, 2, 7, 4096]) {
    const result = await parse(
      enc.encode(raw),
      'Multipart/Mixed; x=extra; boundary="te\\st"; z="a;b"',
      split,
    );
    assertEquals(result.bytes, enc.encode('\u0000abc'));
    assertEquals(result.contentType, 'application/octet-stream');
  }
});

Deno.test('external MIME: captured Synapse and tuwunel bytes and synthetic HTTP framing', async () => {
  for (const peer of ['synapse', 'tuwunel']) {
    const root = 'tests/fixtures/federation-media/' + peer;
    const capture = JSON.parse(await Deno.readTextFile(root + '.json'));
    const body = await Deno.readFile(root + '.bin');
    const bodyHash = new Uint8Array(
      await crypto.subtle.digest('SHA-256', body),
    );
    assertEquals(
      Array.from(bodyHash, (b) => b.toString(16).padStart(2, '0')).join(''),
      capture.body_sha256,
    );
    const type = capture.headers['Content-Type'];
    const expectedHash = capture.payload_sha256;
    for (const split of [1, 2, 7, 64, 4096]) {
      const result = await parse(body, type, split);
      assertEquals(result.size, 51);
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', result.bytes),
      );
      assertEquals(
        Array.from(hash, (x) => x.toString(16).padStart(2, '0')).join(''),
        expectedHash,
      );
      for (const chunked of [false, true]) {
        const head = enc.encode(
          'HTTP/1.1 200 OK\r\nContent-Type: ' + type + '\r\n' +
            (chunked
              ? 'Transfer-Encoding: chunked'
              : 'Content-Length: ' + body.length) +
            '\r\n\r\n',
        );
        const chunks = chunked
          ? [
            enc.encode(body.length.toString(16) + '\r\n'),
            body,
            enc.encode('\r\n0\r\n\r\n'),
          ]
          : [body];
        const wire = Uint8Array.from([head, ...chunks].flatMap((c) => [...c]));
        const output: Uint8Array[] = [];
        await http1Wire(connection(wire, split), {
          ...opts,
          sink: (_status, headers) =>
            mediaMultipart(
              headers.get('content-type')!,
              new WritableStream({
                write(c) {
                  output.push(c.slice());
                },
              }),
              100000,
            ).stream,
        });
        assertEquals(
          Uint8Array.from(output.flatMap((c) => [...c])),
          result.bytes,
        );
      }
    }
  }
});

Deno.test('external MIME: CTE is explicit and invalid unquoted boundary tokens refused', async () => {
  const raw =
    '--test\r\nContent-Type: application/json\r\n\r\n{}\r\n--test\r\nContent-Transfer-Encoding: base64\r\n\r\nYWJj\r\n--test--';
  await assertRejects(() =>
    parse(enc.encode(raw), 'multipart/mixed; boundary=test', 1)
  );
  await assertRejects(() =>
    parse(enc.encode(raw), 'multipart/mixed; boundary=te/st', 1)
  );
});
