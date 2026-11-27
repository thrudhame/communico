import { assertEquals } from '@std/assert';
import { adminCall } from './admin-client.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('04-media-copy: an acknowledged offline upload arrives at cold home', async () => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const server = 'logical.test';
  const node = 'edge_a';
  const facadeReady = 'facade: link/local admin ready';
  const homeReady = 'federation: enabled';
  let home: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  let edge: Awaited<ReturnType<typeof facadeProcess>> | undefined;
  let homePort: number;
  let edgePort: number;
  const request = (port: number, path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}/_matrix/${path}`, init);
  const json = (value: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const credentials = { username: 'owner', password: 'media-copy-password' };
  const login = async (port: number) => {
    const reply = await request(
      port,
      'client/v3/login',
      json({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: credentials.username },
        password: credentials.password,
        device_id: 'media-copy',
      }),
    );
    const body = await reply.json();
    assertEquals(reply.status, 200, body.error);
    return { authorization: `Bearer ${body.access_token}` };
  };
  try {
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="${server}"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\n` +
          `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${side}.crt"\nkey="${tls.dir}/${side}.key"\n` +
          `[facade]\nphase="f2"\nnodeid="${node}"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
          (side === 'home'
            ? `nodes=["${node}"]\npairfile="${bundlefile}"\n`
            : ''),
      );
    }
    edge = await facadeProcess(file('facade'), facadeReady);
    const linkPort = await edge.port('link');
    await fixtureLink(file('home'), linkPort);
    assertEquals(
      (await adminCall(socket('facade'), 'facade/initialize')).status,
      200,
    );
    home = await facadeProcess(file('home'), homeReady);
    homePort = await home.port('client');
    const register = (body: unknown) =>
      request(homePort, 'client/v3/register', json(body));
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
    const homeAuth = {
      authorization: `Bearer ${(await enrolled.json()).access_token}`,
    };
    const paired = await adminCall(socket('home'), 'facade/pair', {
      node,
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
        stream: `${stream}:@owner:${server}`,
      }, () => true);
    }
    await home.stop();
    edgePort = await edge.port('client');
    const edgeAuth = await login(edgePort);
    const bytes = 'offline upload\n'.repeat(100_000);
    const upload = await request(
      edgePort,
      'media/v3/upload?filename=offline.txt',
      {
        method: 'POST',
        headers: { ...edgeAuth, 'content-type': 'text/plain' },
        body: bytes,
      },
    );
    assertEquals(upload.status, 200);
    const { content_uri } = await upload.json();
    const path = `client/v1/media/download/${
      content_uri.slice('mxc://'.length)
    }`;
    assertEquals(
      await (await request(edgePort, path, { headers: edgeAuth })).text(),
      bytes,
    );
    await edge.stop();
    edge = await facadeProcess(file('facade'), facadeReady);
    edgePort = await edge.port('client');
    home = await facadeProcess(file('home'), homeReady);
    homePort = await home.port('client');
    const deadline = Date.now() + 8_000;
    for (;;) {
      const result = await request(homePort, path, { headers: homeAuth });
      if (result.status === 200) {
        assertEquals(await result.text(), bytes);
        assertEquals(result.headers.get('content-type'), 'text/plain');
        assertEquals(
          result.headers.get('content-length'),
          String(bytes.length),
        );
        break;
      }
      await result.body?.cancel();
      if (Date.now() >= deadline) {
        assertEquals(
          result.status,
          200,
          'cold home never served the acknowledged facade upload',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await edge.stop();
    await home.stop();
    home = await facadeProcess(file('home'), homeReady);
    assertEquals(
      await (await request(await home.port('client'), path, {
        headers: homeAuth,
      })).text(),
      bytes,
    );
  } finally {
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});
