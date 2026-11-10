import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { config, serverName, setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';

const suite = httpSuite('HTTP shared request body limit');
for (const kind of ['report', 'account-data']) {
  suite.test(
    'oversized ' + kind + ' JSON request gets Matrix 413 before dispatch',
    async () => {
      const user = await suite.registerTestUser('body-limit-' + kind, 'pw');
      const headers = { Authorization: 'Bearer ' + user.access_token };
      const create = await suite.matrix(
        new Request('http://x/_matrix/client/v3/createRoom', {
          method: 'POST',
          headers,
          body: '{}',
        }),
      );
      assertEquals(create.status, 200);
      const room = (await create.json()).room_id;
      const bytes = JSON.stringify({ reason: 'x'.repeat(200 * 65536) });
      const [path, method] = kind === 'report'
        ? [
          '/_matrix/client/v3/rooms/' + encodeURIComponent(room) + '/report',
          'POST',
        ]
        : [
          '/_matrix/client/v3/user/' + encodeURIComponent(user.user_id) +
          '/account_data/example.large',
          'PUT',
        ];
      const response = await suite.matrix(
        new Request('http://x' + path, { method, headers, body: bytes }),
      );
      assertEquals(response.status, 413);
      assertEquals((await response.json()).errcode, 'M_TOO_LARGE');
    },
  );
}

suite.test('streamed bodies count UTF-8 bytes, allow the exact limit, and protect ignored-body/missing routes', async () => {
  const user = await suite.registerTestUser('body-stream', 'pw');
  const previous = config().server;
  setConfigForTests({ server: { maxrequestbytes: 128 } });
  const headers = { Authorization: 'Bearer ' + user.access_token };
  const path = '/_matrix/client/v3/user/' + encodeURIComponent(user.user_id) +
    '/account_data/example.bytes';
  const send = async (path: string, text: string, method = 'PUT') => {
    const bytes = new TextEncoder().encode(text);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 64));
        c.enqueue(bytes.slice(64));
        c.close();
      },
    });
    return await suite.matrix(
      new Request('http://x' + path, { method, headers, body: stream }),
    );
  };
  try {
    const exact = JSON.stringify({ x: 'a'.repeat(120) });
    assertEquals(new TextEncoder().encode(exact).length, 128);
    const response = await send(path, exact);
    assertEquals(response.status, 200);
    await response.body?.cancel();
    for (
      const [target, method] of [
        [path, 'PUT'],
        ['/_matrix/client/v3/logout', 'POST'],
        ['/_matrix/client/v3/not-real', 'POST'],
        ['/_matrix/key/v2/server', 'POST'],
      ]
    ) {
      const large = await send(
        target,
        JSON.stringify({ x: 'a'.repeat(121) }),
        method,
      );
      assertEquals(large.status, 413);
      assertEquals((await large.json()).errcode, 'M_TOO_LARGE');
    }
    const unicode = await send(path, JSON.stringify({ x: 'é'.repeat(61) }));
    assertEquals(unicode.status, 413);
    assertEquals((await unicode.json()).errcode, 'M_TOO_LARGE');
  } finally {
    setConfigForTests({ server: previous });
  }
});

suite.test('both upload routes retain the separate streaming media limit', async () => {
  const user = await suite.registerTestUser('body-upload', 'pw');
  const previous = config();
  const root = await Deno.makeTempDir({ prefix: 'body-media-' });
  setConfigForTests({
    server: { maxrequestbytes: 8 },
    media: { root, maxbytes: 128 },
  });
  const headers = { Authorization: 'Bearer ' + user.access_token };
  try {
    const upload = await suite.matrix(
      new Request('http://x/_matrix/media/v3/upload', {
        method: 'POST',
        headers,
        body: new Uint8Array(100),
      }),
    );
    assertEquals(upload.status, 200);
    await upload.json();
    const create = await suite.matrix(
      new Request('http://x/_matrix/media/v1/create', {
        method: 'POST',
        headers,
        body: '{}',
      }),
    );
    assertEquals(create.status, 200);
    const id = String((await create.json()).content_uri).split('/').at(-1)!;
    const put = await suite.matrix(
      new Request(
        'http://x/_matrix/media/v3/upload/' + serverName() + '/' + id,
        {
          method: 'PUT',
          headers,
          body: new Uint8Array(100),
        },
      ),
    );
    assertEquals(put.status, 200);
    await put.json();
    const tooLarge = await suite.matrix(
      new Request('http://x/_matrix/media/v3/upload', {
        method: 'POST',
        headers,
        body: new Uint8Array(129),
      }),
    );
    assertEquals(tooLarge.status, 413);
    assertEquals((await tooLarge.json()).errcode, 'M_TOO_LARGE');
    const media = (await theApp().tenant.tx((tx) => tx.media.byId(id)))!;
    assertEquals(media.size_bytes, 100);
  } finally {
    setConfigForTests(previous);
    await Deno.remove(root, { recursive: true });
  }
});
