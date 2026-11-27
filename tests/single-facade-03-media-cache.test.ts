import { assert, assertEquals } from '@std/assert';
import { Image } from 'imagescript';
import { multipartResponse } from '#engine/media/multipart.ts';
import { adminCall } from './admin-client.ts';
import { startFakeServer } from './federation/fake-server.ts';
import { facadeProcess as process } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { facadeTls } from './support/facade-tls.ts';
import { homeIp, mappedHome, peerIp } from './support/facade-media-wire.ts';

Deno.test('single facade media cache: offline foreign and derived reads never dial home', async (test) => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const png = await Deno.readFile('tests/fixtures/matrix.png');
  const ciphertext = new Uint8Array([0, 255, 128, 24, 1, 0, 3]);
  const download = '/_matrix/client/v1/media/download/';
  const thumb = '/_matrix/client/v1/media/thumbnail/';
  const preview = (url: string, mount = 'client/v1/media') =>
    `/_matrix/${mount}/preview_url?url=${encodeURIComponent(url)}`;
  const ready = 'facade: link/local admin ready';
  const start = () =>
    process(file('facade'), ready, [], {
      entrypoint: 'tests/fixtures/facade-media-child.ts',
    });
  const connects = async () =>
    (await Deno.readTextFile(file('facade') + '.connects')).trim().split('\n')
      .filter(Boolean);
  const encoded = async (r: Response) => new Uint8Array(await r.arrayBuffer());
  let edge: Awaited<ReturnType<typeof start>> | undefined;
  let home: Awaited<ReturnType<typeof process>> | undefined;
  let peer: Awaited<ReturnType<typeof startFakeServer>> | undefined;
  let previewServer: Deno.HttpServer | undefined;
  let port = 0;
  let token = '';
  const request = (path: string, auth = true, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: {
        ...(auth ? { authorization: 'Bearer ' + token } : {}),
        ...init?.headers,
      },
    });
  try {
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="logical.test"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\nmaxbytes=262144\n` +
          `[preview]\nenabled=true\n` +
          `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${side}.crt"\nkey="${tls.dir}/${side}.key"\ncacerts=["tests/fixtures/tls/ca.crt"]\n` +
          `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
          (side === 'home'
            ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n`
            : ''),
      );
    }
    await Deno.writeTextFile(file('facade') + '.connects', '');
    edge = await start();
    const linkPort = await edge.port('link');
    await fixtureLink(file('home'), linkPort);
    assertEquals(
      (await adminCall(socket('facade'), 'facade/initialize')).status,
      200,
    );
    home = await process(file('home'), 'federation: enabled');
    const homePort = await home.port('client');
    const userId = '@cache-reader:logical.test';
    const account = { username: 'cache-reader', password: 'offline-test' };
    const register = (body: unknown) =>
      fetch(`http://127.0.0.1:${homePort}/_matrix/client/v3/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const challenge = await register(account);
    assertEquals(challenge.status, 401);
    const registered = await register({
      ...account,
      auth: {
        type: 'm.login.dummy',
        session: (await challenge.json()).session,
      },
    });
    assertEquals(registered.status, 200);
    await registered.body?.cancel();
    const paired = await adminCall(socket('home'), 'facade/pair', {
      node: 'edge_a',
      url: `https://127.0.0.1:${linkPort}`,
      facadePin: tls.facadePin,
      expires: Date.now() + 60_000,
      bundlefile,
    });
    assertEquals(paired.status, 200);
    assertEquals(
      (await adminCall(socket('facade'), 'facade/accept', { bundlefile }))
        .status,
      200,
    );
    for (const stream of ['auth', 'key-bootstrap', 'devices']) {
      await edge.observations.fact({
        peer: 'home',
        source: 'home',
        incarnation: paired.body.result.id,
        stream: `${stream}:${userId}`,
      }, () => true);
    }
    await edge.port('client');
    await home.stop();
    await edge.stop();
    edge = await start();
    port = await edge.port('client');
    const login = await request('/_matrix/client/v3/login', false, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: account.username },
        password: account.password,
        device_id: 'offline-cache',
      }),
    });
    assertEquals(login.status, 200);
    token = (await login.json()).access_token;
    const seen: string[] = [];
    let webPort = 0;
    const web = (path: string, host = peerIp) =>
      `http://${host}:${webPort}${path}`;
    previewServer = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen() {},
    }, (req) => {
      const path = new URL(req.url).pathname;
      seen.push(path);
      assertEquals(req.headers.get('authorization'), null);
      assertEquals(req.headers.get('cookie'), null);
      if (path === '/go') return Response.redirect(web('/page'));
      if (path === '/go-home') {
        return Response.redirect(web('/denied', `[${mappedHome}]`));
      }
      if (path === '/blocked-image') {
        return Response.redirect(web('/denied', homeIp));
      }
      if (path === '/image.png') {
        return new Response(png, { headers: { 'content-type': 'image/png' } });
      }
      return new Response(
        `<meta property="og:title" content="Public preview"><meta property="og:image" content="${
          path === '/hostile-image' ? '/blocked-image' : '/image.png'
        }">`,
        { headers: { 'content-type': 'text/html' } },
      );
    });
    assert('port' in previewServer.addr);
    webPort = previewServer.addr.port;
    const cdn: Array<{ path: string; signed: boolean }> = [];
    let peerPort = 0;
    peer = await startFakeServer({
      async ourKeyDoc() {
        const doc = await request('/_matrix/key/v2/server', false);
        assertEquals(doc.status, 200);
        return await doc.json();
      },
      handlers(req) {
        const { pathname: path, searchParams } = req.url;
        if (path.startsWith('/cdn/')) {
          assertEquals(req.hasAuthorization, false);
          assertEquals(req.hasCookie, false);
          cdn.push({ path, signed: req.verified });
          if (path === '/cdn/go') {
            return Response.redirect(`https://localhost:${peerPort}/cdn/bytes`);
          }
          if (path === '/cdn/go-home') {
            return Response.redirect(
              `https://home.test:${peerPort}/cdn/denied`,
            );
          }
          return new Response(ciphertext);
        }
        if (path.startsWith('/_matrix/media/v3/')) {
          assert(req.verified);
          assertEquals(searchParams.get('allow_remote'), 'false');
          return new Response(ciphertext);
        }
        if (!path.startsWith('/_matrix/federation/v1/media/')) return null;
        assertEquals(req.origin, 'logical.test', 'real X-Matrix signature');
        const id = path.split('/').at(-1)!;
        if (id === 'old' || id === 'missing' || id === 'forbidden') {
          const errcode = {
            old: 'M_UNRECOGNIZED',
            missing: 'M_NOT_FOUND',
            forbidden: 'M_FORBIDDEN',
          }[id];
          return Response.json({ errcode, error: id }, {
            status: id === 'forbidden' ? 403 : 404,
          });
        }
        if (id === 'html') return new Response('not found', { status: 404 });
        if (id === 'malformed') return new Response('not a multipart envelope');
        if (id === 'location' || id === 'location-home') {
          const target = id === 'location' ? 'go' : 'go-home';
          return new Response(
            `--media\r\nContent-Type: application/json\r\n\r\n{}\r\n--media\r\nLocation: https://localhost:${peerPort}/cdn/${target}?token=private\r\n\r\n\r\n--media--\r\n`,
            { headers: { 'content-type': 'multipart/mixed; boundary=media' } },
          );
        }
        if (path.includes('/thumbnail/')) {
          assertEquals(searchParams.get('width'), '16');
          assertEquals(searchParams.get('height'), '16');
          return multipartResponse(
            new Response(png, { headers: { 'content-type': 'image/png' } }),
          );
        }
        return multipartResponse(new Response(ciphertext));
      },
    });
    const foreign = peer.name + '/';
    peerPort = peer.port;
    const assertBytes = async (
      r: Response,
      bytes: Uint8Array,
      context?: string,
    ) => {
      assertEquals(r.status, 200, context);
      assertEquals(await encoded(r), bytes);
    };
    const reject = async (r: Response, code: number, errcode?: string) => {
      assertEquals(r.status, code);
      if (errcode) assertEquals((await r.json()).errcode, errcode);
      else await r.body?.cancel();
    };
    assert(
      await test.step('offline public signed reads, fallback and thumbnail', async () => {
        await assertBytes(
          await request(download + foreign + 'opaque'),
          ciphertext,
          'offline signed foreign read',
        );
        assertEquals(peer!.requests.map((r) => r.path), [
          '/_matrix/federation/v1/media/download/opaque',
        ]);
        await reject(await request(download + foreign + 'opaque', false), 401);
        await reject(
          await request(`/_matrix/media/v3/download/${foreign}opaque`, false),
          404,
        );
        assertEquals(peer!.requests.length, 1);
        for (const id of ['missing', 'forbidden', 'html', 'malformed']) {
          const r = await request(download + foreign + id);
          assert(r.status >= 400);
          await r.body?.cancel();
        }
        assertEquals(
          peer!.requests.length,
          5,
          'no fallback for ordinary upstream errors',
        );
        await assertBytes(
          await request(download + foreign + 'old'),
          ciphertext,
        );
        assertEquals(peer!.requests.slice(-2).map((r) => r.path), [
          '/_matrix/federation/v1/media/download/old',
          `/_matrix/media/v3/download/${
            encodeURIComponent(peer!.name)
          }/old?allow_remote=false`,
        ]);
        const thumbnail = await request(
          thumb + foreign + 'picture?width=16&height=16&method=crop',
        );
        assertEquals(thumbnail.status, 200);
        const image = await Image.decode(await encoded(thumbnail));
        assertEquals([image.width, image.height], [16, 16]);
        const location = await request(download + foreign + 'location');
        assertEquals(location.headers.get('location'), null);
        await assertBytes(location, ciphertext);
        assertEquals(cdn, [{ path: '/cdn/go', signed: false }, {
          path: '/cdn/bytes',
          signed: false,
        }]);
      }),
    );

    let localImage = '';
    assert(
      await test.step('preview MXC and its local thumbnail work after cold restart', async () => {
        const r = await request(preview(web('/go')));
        assertEquals(r.status, 200);
        const body = await r.json();
        assertEquals(body['og:title'], 'Public preview');
        assertEquals(body['matrix:image:size'], png.byteLength);
        assert(/^mxc:\/\/logical\.test\//.test(body['og:image']));
        localImage = body['og:image'].slice('mxc://'.length);
        await edge!.stop();
        edge = await start();
        port = await edge.port('client');
        await assertBytes(await request(download + localImage), png);
        const thumbnail = await request(
          thumb + localImage + '?width=16&height=16&method=crop',
        );
        assertEquals(thumbnail.status, 200);
        const image = await Image.decode(await encoded(thumbnail));
        assertEquals([image.width, image.height], [16, 16]);
        assertEquals(seen, ['/go', '/page', '/image.png']);
      }),
    );

    await test.step('allowlists cannot override learned home, another answer or a redirect', async () => {
      await edge!.stop();
      let config = await Deno.readTextFile(file('facade'));
      config = config.replace(
        '[preview]\n',
        `[preview]\nallowlist=["${homeIp}/32","10.0.0.0/8"]\n`,
      )
        .replace('[media]\n', `[media]\nallowlist=["${homeIp}/32"]\n`);
      await Deno.writeTextFile(
        file('facade'),
        config + 'homecidrs=["11.0.0.0/8"]\n',
      );
      edge = await start();
      port = await edge.port('client');
      const before = (await connects()).length;
      for (
        const host of [
          homeIp,
          `[${mappedHome}]`,
          '10.0.0.1',
          '11.0.0.1',
          'mixed.test',
        ]
      ) {
        for (const mount of ['client/v1/media', 'media/v3']) {
          const path = preview(web('/denied', host), mount);
          await reject(await request(path, false), 401);
          await reject(await request(path), 403, 'M_FORBIDDEN');
        }
      }
      for (const path of [download, thumb]) {
        await reject(
          await request(
            `${path}${homeIp}:${peerPort}/denied?width=16&height=16`,
          ),
          502,
        );
      }
      await reject(await request(download + 'logical.test./absent'), 404);
      assertEquals(
        (await connects()).length,
        before,
        'denied addresses never reach the dial primitive',
      );
      await reject(await request(preview(web('/go-home'))), 403, 'M_FORBIDDEN');
      const page = await request(preview(web('/hostile-image')));
      assertEquals(page.status, 200);
      assertEquals((await page.json())['og:image'], undefined);
      await reject(await request(download + foreign + 'location-home'), 502);
      assertEquals((await connects()).slice(before), Array(5).fill(peerIp));
      assertEquals(seen.slice(3), [
        '/go-home',
        '/hostile-image',
        '/blocked-image',
      ]);
      assertEquals(cdn.at(-1), { path: '/cdn/go-home', signed: false });
    });
  } finally {
    await Promise.allSettled([
      edge?.stop(),
      home?.stop(),
      peer?.close(),
      previewServer?.shutdown(),
    ]);
    await tls.close();
  }
});
