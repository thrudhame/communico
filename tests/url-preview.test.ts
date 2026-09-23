// tests/url-preview.test.ts — GET preview_url (v1 + deprecated v3).
// In-test Deno.serve on 127.0.0.1 serving Complement's /test.html and
// matrix.png. Live doltgres; setConfigForTests flips preview on.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { setConfigForTests } from '#engine/config.ts';
import { registerTestUser } from './util.ts';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const PNG = await Deno.readFile(
  new URL('./fixtures/matrix.png', import.meta.url),
);

const HTML = `
<html prefix="og: http://ogp.me/ns#">
<head>
<title>The Rock (1996)</title>
<meta property="og:title" content="The Rock" />
<meta property="og:type" content="video.movie" />
<meta property="og:url" content="http://www.imdb.com/title/tt0117500/" />
<meta property="og:image" content="test.png" />
</head>
<body></body>
</html>
`;

type Json = Record<string, unknown>;

async function call(
  path: string,
  init: { token?: string } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.token !== undefined) headers.Authorization = `Bearer ${init.token}`;
  const res = await matrix(
    new Request(`http://x${path}`, { method: 'GET', headers }),
  );
  const text = await res.text();
  return { status: res.status, body: text === '' ? {} : JSON.parse(text) };
}

function fixtureServer(): Deno.HttpServer<Deno.NetAddr> {
  return Deno.serve({ hostname: '127.0.0.1', port: 0 }, (req) => {
    const u = new URL(req.url);
    if (u.pathname === '/test.png') {
      return new Response(PNG, {
        headers: { 'Content-Type': 'image/png' },
      });
    }
    if (u.pathname === '/test.html') {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html' },
      });
    }
    if (u.pathname === '/go') {
      return new Response(null, {
        status: 302,
        headers: { Location: 'http://10.0.0.1/x' },
      });
    }
    if (u.pathname === '/big') {
      return new Response('x'.repeat(64), {
        headers: { 'Content-Type': 'text/html', 'Content-Length': '64' },
      });
    }
    return new Response('no', { status: 404 });
  });
}

Deno.test('URL preview: disabled, blocklist, allowlist, redirect, cap, scheme, image, both routes', async (t) => {
  const alice = await registerTestUser('pv-a', 'pw-pv-a');
  const tok = alice.access_token!;
  const server = fixtureServer();
  const port = server.addr.port;
  const base = 'http://127.0.0.1:' + port;
  const q = (path: string, route = '/_matrix/client/v1/media/preview_url') =>
    route + '?url=' + encodeURIComponent(base + path);

  try {
    await t.step('enabled=false → 403', async () => {
      const res = await call(q('/test.html'), { token: tok });
      assertEquals(res.status, 403);
      assertEquals(res.body.errcode, 'M_FORBIDDEN');
    });

    await t.step('default blocklist → 403 for 127.0.0.1', async () => {
      setConfigForTests({ preview: { enabled: true } });
      try {
        const res = await call(q('/test.html'), { token: tok });
        assertEquals(res.status, 403);
        assertEquals(res.body.errcode, 'M_FORBIDDEN');
      } finally {
        setConfigForTests({});
      }
    });

    await t.step(
      'allowlist 127.0.0.0/8 → 200 with og + mxc image',
      async () => {
        setConfigForTests({
          preview: { enabled: true, allowlist: ['127.0.0.0/8'] },
        });
        try {
          const res = await call(q('/test.html'), { token: tok });
          assertEquals(res.status, 200);
          assertEquals(res.body['og:title'], 'The Rock');
          assertEquals(res.body['og:type'], 'video.movie');
          assertEquals(
            res.body['og:url'],
            'http://www.imdb.com/title/tt0117500/',
          );
          assert(String(res.body['og:image']).startsWith('mxc://'));
          assertEquals(res.body['og:image:width'], 279);
          assertEquals(res.body['og:image:height'], 129);
          assertEquals(res.body['matrix:image:size'], 2239);
        } finally {
          setConfigForTests({});
        }
      },
    );

    await t.step('redirect to a blocklisted address → 403', async () => {
      setConfigForTests({
        preview: { enabled: true, allowlist: ['127.0.0.0/8'] },
      });
      try {
        const res = await call(q('/go'), { token: tok });
        assertEquals(res.status, 403);
        assertEquals(res.body.errcode, 'M_FORBIDDEN');
      } finally {
        setConfigForTests({});
      }
    });

    await t.step('page over maxbytes → 502 M_TOO_LARGE', async () => {
      setConfigForTests({
        preview: {
          enabled: true,
          allowlist: ['127.0.0.0/8'],
          maxbytes: 16,
        },
      });
      try {
        const res = await call(q('/big'), { token: tok });
        assertEquals(res.status, 502);
        assertEquals(res.body.errcode, 'M_TOO_LARGE');
      } finally {
        setConfigForTests({});
      }
    });

    await t.step('non-http scheme → 400', async () => {
      setConfigForTests({ preview: { enabled: true } });
      try {
        const res = await call(
          '/_matrix/client/v1/media/preview_url?url=' +
            encodeURIComponent('ftp://example.com/x'),
          { token: tok },
        );
        assertEquals(res.status, 400);
        assertEquals(res.body.errcode, 'M_INVALID_PARAM');
      } finally {
        setConfigForTests({});
      }
    });

    await t.step('direct image URL → og:image of itself', async () => {
      setConfigForTests({
        preview: { enabled: true, allowlist: ['127.0.0.0/8'] },
      });
      try {
        const res = await call(q('/test.png'), { token: tok });
        assertEquals(res.status, 200);
        assertEquals(res.body['og:image'], base + '/test.png');
      } finally {
        setConfigForTests({});
      }
    });

    await t.step('both routes (v1 + v3) answer', async () => {
      setConfigForTests({
        preview: { enabled: true, allowlist: ['127.0.0.0/8'] },
      });
      try {
        const v1 = await call(q('/test.html'), { token: tok });
        const v3 = await call(
          q('/test.html', '/_matrix/media/v3/preview_url'),
          { token: tok },
        );
        assertEquals(v1.status, 200);
        assertEquals(v3.status, 200);
        assertEquals(v1.body['og:title'], v3.body['og:title']);
      } finally {
        setConfigForTests({});
      }
    });
  } finally {
    await server.shutdown();
  }
});
