import { assertEquals } from '@std/assert';
import { config, setConfigForTests } from '#engine/config.ts';
import { startHttp } from '#tests/http-app.ts';

Deno.test('media: dotted, port-bearing and IPv6 local names round-trip through reserved uploads and both downloads', async () => {
  const previousName = config().server.name;
  const previousMedia = config().media;
  const root = await Deno.makeTempDir({ prefix: 'review-media-names-' });
  try {
    for (
      const name of [
        'media.example.org',
        'media.example.org:8448',
        '[2001:db8::1]:8448',
      ]
    ) {
      setConfigForTests({ server: { name }, media: { root } });
      const http = await startHttp();
      try {
        const user = await http.registerTestUser('media-name', 'pw');
        const headers = { Authorization: 'Bearer ' + user.access_token };
        const created = await http.matrix(
          new Request('http://x/_matrix/media/v1/create', {
            method: 'POST',
            headers,
          }),
        );
        assertEquals(created.status, 200);
        const uri = (await created.json()).content_uri as string;
        assertEquals(uri.startsWith('mxc://' + name + '/'), true);
        const id = uri.slice(('mxc://' + name + '/').length);
        const suffix = encodeURIComponent(name) + '/' + id;
        const bytes = new Uint8Array([12, 34, 56]);
        const uploaded = await http.matrix(
          new Request('http://x/_matrix/media/v3/upload/' + suffix, {
            method: 'PUT',
            headers: { ...headers, 'Content-Type': 'text/plain' },
            body: bytes,
          }),
        );
        await uploaded.arrayBuffer();
        assertEquals(uploaded.status, 200, name);
        for (
          const route of [
            '/_matrix/media/v3/download/',
            '/_matrix/client/v1/media/download/',
          ]
        ) {
          const response = await http.matrix(
            new Request('http://x' + route + suffix, { headers }),
          );
          const downloaded = new Uint8Array(await response.arrayBuffer());
          assertEquals(response.status, 200, name + route);
          assertEquals(downloaded, bytes);
          assertEquals(
            response.headers.get('X-Content-Type-Options'),
            'nosniff',
          );
          for (
            const bad of [
              'foreign.example.org/' + id,
              encodeURIComponent(name) + '/bad%2Fid',
            ]
          ) {
            const denied = await http.matrix(
              new Request('http://x' + route + bad, { headers }),
            );
            await denied.arrayBuffer();
            assertEquals(denied.status, 404);
          }
        }
      } finally {
        await http.close();
      }
    }
  } finally {
    setConfigForTests({ server: { name: previousName }, media: previousMedia });
    await Deno.remove(root, { recursive: true });
  }
});
