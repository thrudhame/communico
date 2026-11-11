import { assert, assertEquals } from '@std/assert';
import { Image } from 'imagescript';
import { config, serverName, setConfigForTests } from '#engine/config.ts';
import { startHttp } from '#tests/http-app.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { mediaMultipart, multipartResponse } from '#engine/media/multipart.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { remoteServer, signerFor } from './http-federation.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { buildXMatrixHeader } from '#engine/federation/xmatrix.ts';
import { MediaCache } from '#engine/media/cache.ts';

Deno.test('HTTP thumbnail: shared local/federation engine, signed remote variants, static output and legacy isolation', async () => {
  const old = config();
  const root = await Deno.makeTempDir({ prefix: 'http-thumbnail-' });
  setConfigForTests({
    media: {
      root,
      maxfetches: 1,
      maxvariants: 3,
      cache: { maxbytes: 1000000 },
    },
    federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
  });
  resetCaCertsForTests();
  const http = await startHttp();
  const cleanup = MediaCache.prototype.cleanup;
  let cleanups = 0;
  MediaCache.prototype.cleanup = function (...args) {
    cleanups++;
    return cleanup.apply(this, args);
  };
  const image = new Image(16, 12);
  image.bitmap.fill(255);
  const png = new Uint8Array(await image.encodePNG());
  let fetches = 0;
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: serverName(),
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (
        !req.path.startsWith('/_matrix/federation/v1/media/thumbnail/')
      ) return null;
      assert(req.verified);
      fetches++;
      return multipartResponse(
        new Response(png, { headers: { 'Content-Type': 'image/png' } }),
      );
    },
  });
  try {
    const user = await http.registerTestUser('thumbs', 'pw');
    const headers = { Authorization: 'Bearer ' + user.access_token };
    const upload = await http.matrix(
      new Request('http://x/_matrix/media/v3/upload', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'image/png' },
        body: png,
      }),
    );
    const id = String((await upload.json()).content_uri).split('/').at(-1)!;
    const query = '?width=8&height=8&method=scale&animated=false';
    const path = (origin: string, mediaId: string, legacy = false) =>
      '/_matrix/' + (legacy ? 'media/v3' : 'client/v1/media') + '/thumbnail/' +
      origin + '/' + mediaId;
    const get = (target: string, authed = true) =>
      http.matrix(
        new Request('http://x' + target, { headers: authed ? headers : {} }),
      );
    const absent = await get(path(serverName(), id) + query, false);
    assertEquals(absent.status, 401);
    await absent.arrayBuffer();
    await Deno.writeTextFile(root + '/cache', 'transient directory failure');
    const unavailable = await get(path(serverName(), id) + query);
    assertEquals(unavailable.status, 500);
    await unavailable.arrayBuffer();
    await Deno.remove(root + '/cache');
    const local = await get(path(serverName(), id) + query);
    assertEquals(local.status, 200);
    assertEquals(local.headers.get('Content-Type'), 'image/png');
    const localBytes = new Uint8Array(await local.arrayBuffer());
    const decoded = await Image.decode(localBytes);
    assertEquals([decoded.width, decoded.height], [8, 6]);
    const beforeHits = cleanups;
    const legacyLocal = await get(path(serverName(), id, true) + query, false);
    assertEquals(legacyLocal.status, 200);
    assertEquals(new Uint8Array(await legacyLocal.arrayBuffer()), localBytes);
    assertEquals(
      cleanups,
      beforeHits,
      'thumbnail hits must not own maintenance',
    );
    const before = await get(path(fake.name, 'remote', true) + query, false);
    assertEquals(before.status, 404);
    await before.arrayBuffer();
    assertEquals(fetches, 0);
    for (
      const [suffix, geometry, count] of [
        [query, [8, 6], 1],
        [query, [8, 6], 1],
        ['?width=8&height=8&method=crop', [8, 8], 2],
        ['?width=8&height=8&method=scale&animated=true', [8, 6], 3],
      ] as const
    ) {
      const response = await get(path(fake.name, 'remote') + suffix);
      assertEquals(response.status, 200);
      const image = await Image.decode(
        new Uint8Array(await response.arrayBuffer()),
      );
      assertEquals<number[]>([image.width, image.height], [...geometry]);
      assertEquals(fetches, count);
    }
    const after = await get(path(fake.name, 'remote', true) + query, false);
    assertEquals(after.status, 404);
    await after.arrayBuffer();
    assertEquals(fetches, 3);
    const capped = await get(
      path(fake.name, 'remote') + '?width=7&height=7&method=crop',
    );
    assertEquals(capped.status, 429);
    await capped.arrayBuffer();
    assertEquals(fetches, 3, 'a capped variant never fetches or decodes');
    const peer = await remoteServer('thumb-peer.test');
    const signer = signerFor(peer);
    const target = '/_matrix/federation/v1/media/thumbnail/' + id + query;
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
    const fed = await http.matrix(
      new Request('http://x' + target, {
        headers: { Authorization: authorization },
      }),
    );
    assertEquals(fed.status, 200);
    const chunks: Uint8Array[] = [];
    const parser = mediaMultipart(
      fed.headers.get('content-type')!,
      new WritableStream({
        write(c) {
          chunks.push(c);
        },
      }),
      10000,
    );
    await fed.body!.pipeTo(parser.stream);
    assertEquals(Uint8Array.from(chunks.flatMap((c) => [...c])), localBytes);
    for (
      const suffix of [
        '',
        '?width=0&height=1',
        '?width=1&height=2&method=invalid',
      ]
    ) {
      const bad = await get(path(serverName(), id) + suffix);
      assertEquals(bad.status, 400);
      await bad.arrayBuffer();
    }
    const encrypted = await http.matrix(
      new Request('http://x/_matrix/media/v3/upload', {
        method: 'POST',
        headers,
        body: new Uint8Array([21, 59, 201, 54]),
      }),
    );
    const cipherId = String((await encrypted.json()).content_uri).split('/').at(
      -1,
    )!;
    const noDecrypt = await get(path(serverName(), cipherId) + query);
    assertEquals(noDecrypt.status, 400);
    await noDecrypt.arrayBuffer();
  } finally {
    MediaCache.prototype.cleanup = cleanup;
    await fake.close();
    await http.close();
    setConfigForTests(old);
    resetCaCertsForTests();
    await Deno.remove(root, { recursive: true });
  }
});
