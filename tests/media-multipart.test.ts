import { assertEquals, assertRejects } from '@std/assert';
import { mediaMultipart, multipartResponse } from '#engine/media/multipart.ts';

const enc = new TextEncoder();
const prefix =
  '--test\r\nContent-Type: application/json\r\n\r\n{}\r\n--test\r\n';
const suffix = '\r\n--test--\r\n';
async function parse(
  body: string,
  options: { split?: number; limit?: number; type?: string } = {},
) {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let aborted = false;
  const output = new WritableStream<Uint8Array>({
    write(chunk) {
      chunks.push(chunk.slice());
    },
    close() {
      closed = true;
    },
    abort() {
      aborted = true;
    },
  });
  const parser = mediaMultipart(
    options.type ?? 'multipart/mixed; boundary="test"',
    output,
    options.limit ?? 100,
  );
  const writer = parser.stream.getWriter();
  const bytes = enc.encode(body);
  try {
    for (let i = 0; i < bytes.length; i += options.split ?? 7) {
      await writer.write(bytes.subarray(i, i + (options.split ?? 7)));
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    assertEquals(closed, false);
    assertEquals(aborted, true);
    throw error;
  }
  assertEquals(closed, true);
  return {
    ...parser.result,
    body: new TextDecoder().decode(
      Uint8Array.from(chunks.flatMap((c) => [...c])),
    ),
  };
}

Deno.test('media multipart: binary split at every boundary byte and quoted boundary', async () => {
  for (const split of [1, 2, 7, 1024]) {
    const result = await parse(
      prefix +
        'Content-Type: image/png\r\nContent-Disposition: inline; filename="a.png"\r\n\r\nA\0\r\n--testX\xffZ' +
        suffix,
      { split },
    );
    assertEquals(result.body, 'A\0\r\n--testX\xffZ');
    assertEquals(result.contentType, 'image/png');
    assertEquals(result.disposition, 'inline; filename="a.png"');
    assertEquals(result.location, null);
  }
});
Deno.test('media multipart: Location is separate from binary and cannot contain a payload', async () => {
  const result = await parse(
    prefix + 'Location: https://cdn.example/x?secret=1\r\n\r\n' + suffix,
  );
  assertEquals(result.location, 'https://cdn.example/x?secret=1');
  assertEquals(result.size, 0);
  await assertRejects(() =>
    parse(prefix + 'Location: https://cdn.example/x\r\n\r\nx' + suffix)
  );
});
Deno.test('media multipart: truncation and extra parts never commit output', async () => {
  for (
    const body of [
      prefix + 'Content-Type: image/png\r\n\r\nx',
      prefix +
      'Content-Type: image/png\r\n\r\nx\r\n--test\r\nContent-Type: text/plain\r\n\r\nx' +
      suffix,
    ]
  ) {
    await assertRejects(() => parse(body));
  }
});
Deno.test('media multipart: epilogue is ignored without adding bytes to media', async () => {
  assertEquals(
    (await parse(
      prefix + 'Content-Type: image/png\r\n\r\nx' + suffix + 'extra',
    )).body,
    'x',
  );
});
Deno.test('media multipart: metadata must be bounded JSON object with correct type', async () => {
  for (const metadata of ['[]', 'null', 'oops', '"text"', ' '.repeat(65537)]) {
    await assertRejects(() =>
      parse(
        prefix.replace('{}', metadata) + 'Content-Type: image/png\r\n\r\nx' +
          suffix,
      )
    );
  }
  await assertRejects(() =>
    parse(
      prefix.replace('application/json', 'text/plain') +
        'Content-Type: image/png\r\n\r\nx' + suffix,
    )
  );
});
Deno.test('media multipart: bytes and headers have independent caps', async () => {
  const body = prefix + 'Content-Type: image/png\r\n\r\n12345' + suffix;
  assertEquals((await parse(body, { limit: 5 })).size, 5);
  await assertRejects(() => parse(body, { limit: 4 }));
  await assertRejects(() =>
    parse(prefix + 'X-Large: ' + 'x'.repeat(16385) + '\r\n\r\nx' + suffix)
  );
});
Deno.test('media multipart: duplicated headers and ambiguous media type are refused', async () => {
  await assertRejects(() =>
    parse(
      prefix + 'Location: https://a/x\r\nLocation: https://b/x\r\n\r\n' +
        suffix,
    )
  );
  for (
    const type of [
      'text/plain; boundary=test',
      'multipart/mixed',
      'multipart/mixed; boundary=""',
      'multipart/mixed; boundary=test; boundary=evil',
    ]
  ) {
    await assertRejects(() =>
      parse(prefix + 'Content-Type: image/png\r\n\r\nx' + suffix, { type })
    );
  }
});

Deno.test('media multipart: producer streams a two-part envelope consumed byte-for-byte', async () => {
  const bytes = Uint8Array.from({ length: 100000 }, (_, i) => i % 256);
  const response = multipartResponse(
    new Response(bytes, {
      headers: {
        'Content-Type': 'image/png',
        'Content-Disposition': 'inline; filename="a.png"',
        'Content-Length': String(bytes.length),
      },
    }),
  );
  const chunks: Uint8Array[] = [];
  const parser = mediaMultipart(
    response.headers.get('content-type')!,
    new WritableStream({
      write(chunk) {
        chunks.push(chunk.slice());
      },
    }),
    bytes.length,
  );
  await response.body!.pipeTo(parser.stream);
  const result = new Uint8Array(parser.result.size);
  let offset = 0;
  for (const c of chunks) {
    result.set(c, offset);
    offset += c.length;
  }
  assertEquals(result, bytes);
  assertEquals(parser.result.contentType, 'image/png');
  assertEquals(parser.result.disposition, 'inline; filename="a.png"');
});
Deno.test('media multipart: producer cancellation closes underlying file source', async () => {
  let cancelled = false;
  const response = multipartResponse(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  assertEquals(cancelled, true);
});
