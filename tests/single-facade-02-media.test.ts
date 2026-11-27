import { assert, assertEquals, assertRejects } from '@std/assert';
import { capabilities } from '#engine/facade/capabilities.ts';
import { setConfigForTests } from '#engine/config.ts';
import { signJson } from '#engine/signing-primitives.js';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { adminCall } from './admin-client.ts';
import { makeServer, seedServer } from './federation/doc-helper.ts';
import { facadeProcess as process } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('single facade media: F2 admits local upload and origin read without home', () => {
  const facade = capabilities('facade', 'f2');
  const routes = [
    ['POST', '/_matrix/media/v3/upload'],
    ['POST', '/_matrix/media/v1/create'],
    ['PUT', '/_matrix/media/v3/upload/logical.test/example'],
    ['GET', '/_matrix/client/v1/media/download/logical.test/example'],
    ['GET', '/_matrix/media/v3/download/logical.test/example'],
    ['GET', '/_matrix/federation/v1/media/download/example'],
  ];
  const denied = [];
  for (const [method, path] of routes) {
    const request = new Request('https://logical.test' + path, { method });
    // The facade retains local scopes, not a live home ingress grant.
    const rejection = facade.gate(request, () => true);
    if (rejection) denied.push([method, path, rejection.status]);
    assertEquals(
      capabilities('facade', 'f1').gate(request, () => true)?.status,
      404,
    );
  }
  assertEquals(denied, []);
  for (const prefix of ['client/v1/media', 'media/v3']) {
    assertEquals(
      facade.gate(
        new Request(`https://logical.test/_matrix/${prefix}/preview_url`),
        () => true,
      )?.status,
      404,
    );
  }
});

Deno.test('single facade media: offline wire upload and signed cold read', async () => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  setConfigForTests({ server: { name: 'logical.test' } });
  const remote = await makeServer('media-peer.test');
  let edge: Awaited<ReturnType<typeof process>> | undefined;
  let home: Awaited<ReturnType<typeof process>> | undefined;
  try {
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="logical.test"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\nmaxbytes=64\n` +
          `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${side}.crt"\nkey="${tls.dir}/${side}.key"\n` +
          `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
          (side === 'home'
            ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n`
            : ''),
      );
    }
    const seed = await openStore({
      dir: `${tls.dir}/facade-store`,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
    try {
      await seedServer(await seed.server(), remote);
    } finally {
      await seed.close();
    }
    edge = await process(file('facade'), 'facade: link/local admin ready');
    const linkPort = await edge.port('link');
    await fixtureLink(file('home'), linkPort);
    assertEquals(
      (await adminCall(socket('facade'), 'facade/initialize')).status,
      200,
    );
    home = await process(file('home'), 'federation: enabled');
    const homePort = await home.port('client');
    const register = (body: unknown) =>
      fetch(`http://127.0.0.1:${homePort}/_matrix/client/v3/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const credentials = {
      username: 'media-owner',
      password: 'local-media-password',
    };
    const registration = await register(credentials);
    assertEquals(registration.status, 401);
    const enrolled = await register({
      ...credentials,
      auth: {
        type: 'm.login.dummy',
        session: (await registration.json()).session,
      },
    });
    assertEquals(enrolled.status, 200);
    await enrolled.body?.cancel();
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
        stream: `${stream}:@media-owner:logical.test`,
      }, () => true);
    }
    let port = await edge.port('client');
    await home.stop();
    await assertRejects(() =>
      Deno.connect({ hostname: '127.0.0.1', port: homePort })
    );
    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    const state =
      (await adminCall(socket('facade'), 'facade/status')).body.result;
    await edge.observations.tail(
      'home',
      state.streams.filter(
        (row: { stream: string }) =>
          row.stream.endsWith(':@media-owner:logical.test'),
      ),
    );
    port = await edge.port('client');
    const login = await fetch(
      `http://127.0.0.1:${port}/_matrix/client/v3/login`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: credentials.username },
          password: credentials.password,
          device_id: 'offline-media',
        }),
      },
    );
    const session = await login.json();
    assertEquals(login.status, 200, login.ok ? undefined : session.error);
    const token = session.access_token;
    const request = (
      path: string,
      method = 'GET',
      body?: string,
      auth = true,
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(auth ? { authorization: 'Bearer ' + token } : {}),
          ...(body ? { 'content-type': 'text/plain' } : {}),
        },
        body,
      });
    const media = '/_matrix/media/v3';
    const reserve = '/_matrix/media/v1/create';
    const origin = '/_matrix/federation/v1/media/download/';
    // Observe all four endpoints, even on the pre-feature tree.
    const [direct, pending, fillProbe, signedProbe] = await Promise.all([
      request(media + '/upload?filename=direct.txt', 'POST', 'direct bytes'),
      request(reserve, 'POST'),
      request(media + '/upload/logical.test/example', 'PUT', 'ignored'),
      request(origin + 'example', 'GET', undefined, false),
    ]);
    const statuses = [
      direct.status,
      pending.status,
      fillProbe.status,
      signedProbe.status,
    ];
    await fillProbe.body?.cancel();
    await signedProbe.body?.cancel();
    const directBody = await direct.json();
    const pendingBody = await pending.json();
    assertEquals(
      statuses,
      [200, 200, 404, 401],
      JSON.stringify([
        directBody.errcode,
        directBody.error,
        pendingBody.errcode,
        pendingBody.error,
      ]),
    );
    const prefix = 'mxc://logical.test/';
    assert(directBody.content_uri.startsWith(prefix));
    assert(pendingBody.content_uri.startsWith(prefix));
    const directId = directBody.content_uri.slice(prefix.length);
    const pendingId = pendingBody.content_uri.slice(prefix.length);
    assert(
      directId.length > 24 && pendingId.length > 24 && directId !== pendingId,
    );
    const download = '/_matrix/client/v1/media/download/logical.test/';
    const unfilled = await request(download + pendingId);
    assertEquals(unfilled.status, 504);
    assertEquals((await unfilled.json()).errcode, 'M_NOT_YET_UPLOADED');
    const put = media + '/upload/logical.test/' + pendingId;
    const completed = await request(
      put + '?filename=reserved.txt',
      'PUT',
      'reserved bytes',
    );
    assertEquals(completed.status, 200);
    assertEquals(await completed.json(), {});
    const overwrite = await request(put, 'PUT', 'changed bytes');
    assertEquals(overwrite.status, 409);
    await overwrite.body?.cancel();
    const unauth = await request(download + directId, 'GET', undefined, false);
    assertEquals(unauth.status, 401);
    await unauth.body?.cancel();
    const oversize = await request(media + '/upload', 'POST', 'x'.repeat(65));
    assertEquals(oversize.status, 413);
    await oversize.body?.cancel();

    await edge.stop();
    edge = await process(file('facade'), 'facade: link/local admin ready');
    port = await edge.port('client');
    for (const [id, label] of [[directId, 'direct'], [pendingId, 'reserved']]) {
      const expected = `${label} bytes`;
      const client = await request(download + id);
      assertEquals(client.status, 200);
      assertEquals(client.headers.get('content-type'), 'text/plain');
      assertEquals(
        client.headers.get('content-length'),
        String(expected.length),
      );
      assertEquals(client.headers.get('x-content-type-options'), 'nosniff');
      assert(
        client.headers.get('content-disposition')?.includes(`${label}.txt`),
      );
      assertEquals(await client.text(), expected);

      const path = origin + id;
      const signed = await signJson(
        {
          method: 'GET',
          uri: path,
          origin: remote.name,
          destination: 'logical.test',
        },
        remote.name,
        remote.keyId,
        remote.kp.privateKey,
      );
      const signature = signed.signatures[remote.name][remote.keyId];
      const peer = await fetch(`http://127.0.0.1:${port}${path}`, {
        headers: {
          authorization:
            `X-Matrix origin="${remote.name}",key="${remote.keyId}",sig="${signature}"`,
        },
      });
      assertEquals(peer.status, 200, await peer.clone().text());
      const boundary = peer.headers.get('content-type')?.split('boundary=')[1];
      assert(boundary);
      const multipart = await peer.text();
      assert(
        multipart.includes(
          `\r\nContent-Type: text/plain\r\nContent-Disposition: inline; filename="${label}.txt"`,
        ),
      );
      assert(multipart.endsWith(`\r\n\r\n${expected}\r\n--${boundary}--\r\n`));
    }
  } finally {
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});
