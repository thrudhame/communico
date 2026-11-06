// doltgres URL preview assertions; every actual network hop is loopback.
import { assert, assertEquals } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP URL previews');
const PNG = await Deno.readFile(
  new URL('./fixtures/matrix.png', import.meta.url),
);
const HTML = '<html><head><title>The Rock (1996)</title>' +
  '<meta property="og:title" content="The Rock" />' +
  '<meta property="og:type" content="video.movie" />' +
  '<meta property="og:url" content="http://www.imdb.com/title/tt0117500/" />' +
  '<meta property="og:image" content="test.png" /></head><body></body></html>';

async function call(path: string, token?: string, language?: string) {
  const headers = new Headers();
  if (token !== undefined) headers.set('Authorization', 'Bearer ' + token);
  if (language !== undefined) headers.set('Accept-Language', language);
  const res = await suite.matrix(new Request('http://x' + path, { headers }));
  return { status: res.status, body: await res.json() as Json };
}

let sequence = 0;
function test(
  name: string,
  preview: Partial<ReturnType<typeof config>['preview']>,
  fn: (
    f: {
      token: string;
      base: string;
      seen: { path: string; language: string | null }[];
    },
  ) => Promise<void>,
) {
  suite.test(name, async () => {
    const root = await Deno.makeTempDir({ prefix: 'http-preview-' });
    const previousMedia = config().media;
    const previousPreview = config().preview;
    setConfigForTests({ media: { root, maxbytes: 4096 }, preview });
    const seen: { path: string; language: string | null }[] = [];
    const fake = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen: () => {},
    }, (req) => {
      const path = new URL(req.url).pathname;
      seen.push({ path, language: req.headers.get('Accept-Language') });
      if (path === '/test.png') {
        return new Response(PNG, { headers: { 'Content-Type': 'image/png' } });
      }
      if (path === '/test.html') {
        return new Response(HTML, { headers: { 'Content-Type': 'text/html' } });
      }
      // Policy must reject this redirect before a connection is attempted.
      if (path === '/go') {
        return new Response(null, {
          status: 302,
          headers: { Location: 'http://10.0.0.1/x' },
        });
      }
      if (path === '/big') {
        return new Response('x'.repeat(64), {
          headers: { 'Content-Type': 'text/html', 'Content-Length': '64' },
        });
      }
      return new Response('no', { status: 404 });
    });
    try {
      const user = await suite.registerTestUser('preview-' + sequence++, 'pw');
      await fn({
        token: user.access_token!,
        base: 'http://127.0.0.1:' + fake.addr.port,
        seen,
      });
    } finally {
      await fake.shutdown();
      setConfigForTests({ media: previousMedia, preview: previousPreview });
      await Deno.remove(root, { recursive: true });
    }
  });
}
const query = (url: string, route = '/_matrix/client/v1/media/preview_url') =>
  route + '?url=' + encodeURIComponent(url);
const allowed = { enabled: true, allowlist: ['127.0.0.0/8'] };

test(
  'enabled=false is 403 before fetching',
  { enabled: false },
  async ({ token, base, seen }) => {
    const res = await call(query(base + '/test.html'), token);
    assertEquals(res.status, 403);
    assertEquals(res.body.errcode, 'M_FORBIDDEN');
    assertEquals(seen, []);
  },
);

test(
  'default blocklist refuses loopback before fetching',
  { enabled: true },
  async ({ token, base, seen }) => {
    const res = await call(query(base + '/test.html'), token);
    assertEquals(res.status, 403);
    assertEquals(res.body.errcode, 'M_FORBIDDEN');
    assertEquals(seen, []);
  },
);

test(
  'allowlist yields OG metadata and a downloadable byte-equal tenant image',
  allowed,
  async ({ token, base, seen }) => {
    const res = await call(query(base + '/test.html'), token, 'en-GB');
    assertEquals(res.status, 200);
    assertEquals(res.body['og:title'], 'The Rock');
    assertEquals(res.body['og:type'], 'video.movie');
    assertEquals(res.body['og:url'], 'http://www.imdb.com/title/tt0117500/');
    assert(String(res.body['og:image']).startsWith('mxc://'));
    assertEquals(res.body['og:image:width'], 279);
    assertEquals(res.body['og:image:height'], 129);
    assertEquals(res.body['matrix:image:size'], 2239);
    assertEquals(res.body['og:image:type'], 'image/png');
    assertEquals(seen.map((r) => r.path), ['/test.html', '/test.png']);
    assert(seen.every((r) => r.language === 'en-GB'));
    const mxc = String(res.body['og:image']).slice('mxc://'.length);
    const download = await suite.matrix(
      new Request('http://x/_matrix/client/v1/media/download/' + mxc, {
        headers: { Authorization: 'Bearer ' + token },
      }),
    );
    assertEquals(download.status, 200);
    assertEquals(download.headers.get('Content-Type'), 'image/png');
    assertEquals(new Uint8Array(await download.arrayBuffer()), PNG);
  },
);

test(
  'a redirect to a blocked address is 403 without leaving the fake',
  allowed,
  async ({ token, base, seen }) => {
    const res = await call(query(base + '/go'), token);
    assertEquals(res.status, 403);
    assertEquals(res.body.errcode, 'M_FORBIDDEN');
    assertEquals(seen.map((r) => r.path), ['/go']);
  },
);

test(
  'page cap is 502 M_TOO_LARGE',
  { ...allowed, maxbytes: 16 },
  async ({ token, base }) => {
    const res = await call(query(base + '/big'), token);
    assertEquals(res.status, 502);
    assertEquals(res.body.errcode, 'M_TOO_LARGE');
  },
);

test(
  'non-http scheme is 400 before fetching',
  { enabled: true },
  async ({ token, seen }) => {
    const res = await call(query('ftp://example.com/x'), token);
    assertEquals(res.status, 400);
    assertEquals(res.body.errcode, 'M_INVALID_PARAM');
    assertEquals(seen, []);
  },
);

test(
  'a direct image URL preserves the original OG image URL',
  allowed,
  async ({ token, base }) => {
    const res = await call(query(base + '/test.png'), token);
    assertEquals(res.status, 200);
    assertEquals(res.body['og:image'], base + '/test.png');
  },
);

test(
  'both preview routes retain auth, missing-url error and matching OG output',
  allowed,
  async ({ token, base }) => {
    const responses = [];
    for (
      const route of [
        '/_matrix/client/v1/media/preview_url',
        '/_matrix/media/v3/preview_url',
      ]
    ) {
      const denied = await call(query(base + '/test.html', route));
      assertEquals(denied.status, 401);
      const missing = await call(route, token);
      assertEquals(missing.status, 400);
      assertEquals(missing.body.errcode, 'M_MISSING_PARAM');
      const res = await call(query(base + '/test.html', route), token);
      assertEquals(res.status, 200);
      responses.push(res.body['og:title']);
    }
    assertEquals(responses, ['The Rock', 'The Rock']);
  },
);
