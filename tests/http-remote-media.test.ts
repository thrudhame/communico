import { assert, assertEquals } from '@std/assert';
import { config, serverName, setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';
import { startHttp } from '#tests/http-app.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { mediaMultipart, multipartResponse } from '#engine/media/multipart.ts';
import { remoteServer, signerFor } from './http-federation.ts';
import { buildXMatrixHeader } from '#engine/federation/xmatrix.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { addBlock, removeBlock } from '#engine/federation/peers.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';

Deno.test('HTTP remote media: signed multipart demand/cache/dedup, filenames, policy, strict fallback and legacy isolation', async () => {
  const previous = config();
  const root = await Deno.makeTempDir({ prefix: 'http-remote-media-' });
  setConfigForTests({
    media: { root, maxbytes: 100000 },
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  const http = await startHttp();
  let mode = 'bytes';
  let fetches = 0;
  let legacy = 0;
  const bytes = new Uint8Array([1, 2, 3, 255, 0]);
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: serverName(),
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (req.url.pathname.startsWith('/_matrix/media/v3/download/')) {
        legacy++;
        assertEquals(req.url.searchParams.get('allow_remote'), 'false');
        return new Response(bytes, {
          headers: { 'Content-Type': 'image/png' },
        });
      }
      if (
        !req.url.pathname.startsWith('/_matrix/federation/v1/media/download/')
      ) return null;
      fetches++;
      assert(req.verified);
      if (mode === 'unknown') {
        return Response.json({ errcode: 'M_UNRECOGNIZED', error: 'old peer' }, {
          status: 404,
        });
      }
      if (mode === 'missing') {
        return Response.json({ errcode: 'M_NOT_FOUND', error: 'missing' }, {
          status: 404,
        });
      }
      if (mode === 'html') return new Response('not found', { status: 404 });
      if (mode === 'forbidden') {
        return Response.json({ errcode: 'M_FORBIDDEN', error: 'no' }, {
          status: 403,
        });
      }
      if (mode === 'broken') {
        return new Response('--x\r\nContent-Type: application/json\r\n\r\n{}', {
          headers: { 'Content-Type': 'multipart/mixed; boundary=x' },
        });
      }
      if (mode === 'oversized') {
        return multipartResponse(new Response(new Uint8Array(100001)));
      }
      return multipartResponse(
        new Response(bytes, {
          headers: {
            'Content-Type': 'image/png',
            'Content-Disposition': 'inline; filename="origin.png"',
          },
        }),
      );
    },
  });
  try {
    const user = await http.registerTestUser('remote-media', 'pw');
    const get = (id: string, suffix = '', authed = true, legacyRoute = false) =>
      http.matrix(
        new Request(
          `http://x/_matrix/${
            legacyRoute ? 'media/v3' : 'client/v1/media'
          }/download/${fake.name}/${id}${suffix}`,
          {
            headers: authed
              ? { Authorization: 'Bearer ' + user.access_token }
              : {},
          },
        ),
      );
    const denied = await get('m', '', false);
    assertEquals(denied.status, 401);
    await denied.arrayBuffer();
    assertEquals(fetches, 0);
    const [a, b] = await Promise.all([get('m'), get('m')]);
    for (const response of [a, b]) {
      assertEquals(response.status, 200);
      assertEquals(new Uint8Array(await response.arrayBuffer()), bytes);
      assertEquals(
        response.headers.get('Content-Disposition'),
        'inline; filename="origin.png"',
      );
    }
    assertEquals(fetches, 1);
    const filename = await get('m', '/different.png');
    assertEquals(filename.status, 200);
    assertEquals(
      filename.headers.get('Content-Disposition'),
      'inline; filename="different.png"',
    );
    await filename.arrayBuffer();
    assertEquals(fetches, 1);
    const again = await get('m');
    assertEquals(
      again.headers.get('Content-Disposition'),
      'inline; filename="origin.png"',
    );
    await again.arrayBuffer();
    const anonymous = await get('m', '', false, true);
    assertEquals(anonymous.status, 404);
    await anonymous.arrayBuffer();
    assertEquals(fetches, 1);
    await addBlock(theApp().server, fake.name, null);
    const blocked = await get('m');
    assertEquals(blocked.status, 403);
    await blocked.arrayBuffer();
    assertEquals(fetches, 1);
    await removeBlock(theApp().server, fake.name);
    for (
      const next of ['missing', 'html', 'forbidden', 'broken', 'oversized']
    ) {
      mode = next;
      const response = await get(next);
      assert(response.status >= 400);
      await response.arrayBuffer();
      assertEquals(legacy, 0, next + ' must not downgrade');
    }
    mode = 'unknown';
    const fallback = await get('old');
    assertEquals(fallback.status, 200);
    assertEquals(new Uint8Array(await fallback.arrayBuffer()), bytes);
    assertEquals(legacy, 1);
    assertEquals(
      [...Deno.readDirSync(root + '/cache')].some((e) =>
        e.name.endsWith('.part')
      ),
      false,
    );
  } finally {
    await fake.close();
    await http.close();
    setConfigForTests(previous);
    resetCaCertsForTests();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('HTTP federation media: signature required, local upload served as exact multipart bytes, never a foreign proxy', async () => {
  const previous = config();
  const root = await Deno.makeTempDir({ prefix: 'http-federation-media-' });
  setConfigForTests({ media: { root } });
  const http = await startHttp();
  try {
    const user = await http.registerTestUser('fed-media', 'pw');
    const bytes = new Uint8Array([0, 255, 13, 10, 17]);
    const upload = await http.matrix(
      new Request('http://x/_matrix/media/v3/upload?filename=local.png', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + user.access_token,
          'Content-Type': 'image/png',
        },
        body: bytes,
      }),
    );
    assertEquals(upload.status, 200);
    const id = String((await upload.json()).content_uri).split('/').at(-1)!;
    const path = '/_matrix/federation/v1/media/download/' + id;
    const denied = await http.matrix(new Request('http://x' + path));
    assertEquals(denied.status, 401);
    await denied.arrayBuffer();
    const peer = await remoteServer('media-peer.test');
    const signer = signerFor(peer);
    const signed = async (target: string) => {
      const authorization = buildXMatrixHeader({
        origin: peer.name,
        destination: serverName(),
        key: peer.keyId,
        signature: await signer.sign(
          canonicalJson({
            method: 'GET',
            uri: target,
            origin: peer.name,
            destination: serverName(),
          }),
        ),
      });
      return await http.matrix(
        new Request('http://x' + target, {
          headers: { Authorization: authorization },
        }),
      );
    };
    const response = await signed(path);
    assertEquals(response.status, 200);
    const chunks: Uint8Array[] = [];
    const parser = mediaMultipart(
      response.headers.get('content-type')!,
      new WritableStream({
        write(c) {
          chunks.push(c);
        },
      }),
      100,
    );
    await response.body!.pipeTo(parser.stream);
    assertEquals(Uint8Array.from(chunks.flatMap((c) => [...c])), bytes);
    assertEquals(parser.result.disposition, 'inline; filename="local.png"');
    const bad = await signed(
      '/_matrix/federation/v1/media/download/foreign%2F' + id,
    );
    assertEquals(bad.status, 404);
    await bad.arrayBuffer();
  } finally {
    await http.close();
    setConfigForTests(previous);
    await Deno.remove(root, { recursive: true });
  }
});
