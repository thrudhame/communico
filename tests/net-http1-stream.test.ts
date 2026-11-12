import { assertEquals, assertRejects } from '@std/assert';
import { http1Wire } from '#engine/net/http1.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';

const enc = new TextEncoder();
function wire(raw: string, chunk = 7) {
  const bytes = enc.encode(raw);
  let offset = 0;
  let closed = false;
  return {
    read: (p: Uint8Array) => {
      if (offset === bytes.length) return Promise.resolve(null);
      const n = Math.min(p.length, chunk, bytes.length - offset);
      p.set(bytes.subarray(offset, offset + n));
      offset += n;
      return Promise.resolve(n);
    },
    write: (p: Uint8Array) => Promise.resolve(Math.min(p.length, 3)),
    close: () => {
      closed = true;
    },
    offset: () => offset,
    closed: () => closed,
  };
}
const opts = {
  method: 'GET',
  path: '/',
  hostHeader: 'test',
  headers: {},
  body: null,
  maxBytes: 100000,
};

Deno.test('http1 streaming: sink sees bytes incrementally with backpressure, not a retained body', async () => {
  const conn = wire(
    'HTTP/1.1 200 OK\r\nContent-Length: 70000\r\n\r\n' + 'x'.repeat(70000),
    4096,
  );
  let received = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const request = {
    ...opts,
    sink: (status: number, headers: Headers) => {
      assertEquals(status, 200);
      assertEquals(headers.get('content-length'), '70000');
      return new WritableStream<Uint8Array>({
        write: async (part) => {
          received += part.length;
          entered();
          await blocked;
        },
      });
    },
  };
  const pending = http1Wire(conn, request);
  const response = await Promise.race([started.then(() => null), pending]);
  if (response !== null) {
    release();
    assertEquals(received, 70000, 'sink must receive response bytes');
  }
  const before = conn.offset();
  await Promise.resolve();
  assertEquals(conn.offset(), before, 'blocked sink stops upstream reads');
  release();
  const result = await pending;
  assertEquals(received, 70000);
  assertEquals(result.body.length, 0, 'streamed bytes are not retained');
});

Deno.test('http1 streaming: framing rejects ambiguity, malformed chunks and missing final trailers', async () => {
  for (
    const body of [
      'Content-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
      'Content-Length: 1.5\r\n\r\nx',
      'Transfer-Encoding: chunked\r\n\r\n1z\r\nx\r\n0\r\n\r\n',
      'Transfer-Encoding: chunked\r\n\r\n1\r\nxZZ0\r\n\r\n',
      'Transfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n',
    ]
  ) {
    await assertRejects(
      () => http1Wire(wire('HTTP/1.1 200 OK\r\n' + body, 1), opts),
      UpstreamError,
    );
  }
});

Deno.test('http1 streaming: sink aborts on truncated/oversize input and sink failures propagate', async () => {
  for (
    const body of [
      'Content-Length: 5\r\n\r\nx',
      'Transfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n',
    ]
  ) {
    let aborted = false;
    const request = {
      ...opts,
      maxBytes: 4,
      sink: () =>
        new WritableStream<Uint8Array>({
          abort: () => {
            aborted = true;
          },
        }),
    };
    await assertRejects(
      () => http1Wire(wire('HTTP/1.1 200 OK\r\n' + body), request),
      UpstreamError,
    );
    // Declared oversize is rejected before opening the sink; chunked oversize
    // is discovered after its lifetime has begun and must abort that writer.
    if (body.startsWith('Transfer-Encoding')) assertEquals(aborted, true);
  }
  const request = {
    ...opts,
    sink: () =>
      new WritableStream<Uint8Array>({
        write: () => {
          throw new Error('disk full');
        },
      }),
  };
  await assertRejects(
    () =>
      http1Wire(wire('HTTP/1.1 200 OK\r\nContent-Length: 1\r\n\r\nx'), request),
    Error,
    'disk full',
  );
});
