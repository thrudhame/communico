import { assertEquals } from '@std/assert';
import { adminCall } from './admin-client.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('05-media-wants: cold home fulfills a legacy MXC after offline misses', async () => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const server = 'logical.test';
  const node = 'edge_a';
  const startHome = () => facadeProcess(file('home'), 'federation: enabled');
  const startEdge = () =>
    facadeProcess(file('facade'), 'facade: link/local admin ready');
  const request = (port: number, path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}/_matrix/${path}`, init);
  const json = (value: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const credentials = { username: 'owner', password: 'media-wants-password' };
  let home: Awaited<ReturnType<typeof startHome>> | undefined;
  let edge: Awaited<ReturnType<typeof startEdge>> | undefined;
  try {
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="${server}"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\n` +
          `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${side}.crt"\nkey="${tls.dir}/${side}.key"\n` +
          `[facade]\nphase="f2"\nnodeid="${node}"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\nbatchmaxbytes=8192\n` +
          (side === 'home'
            ? `nodes=["${node}"]\npairfile="${bundlefile}"\n`
            : ''),
      );
    }
    edge = await startEdge();
    const linkPort = await edge.port('link');
    await fixtureLink(file('home'), linkPort);
    assertEquals(
      (await adminCall(socket('facade'), 'facade/initialize')).status,
      200,
    );
    home = await startHome();
    const homePort = await home.port('client');
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
    const bytes = 'legacy home upload\n'.repeat(1500);
    const upload = await request(
      homePort,
      'media/v3/upload?filename=legacy.txt',
      {
        method: 'POST',
        headers: { ...homeAuth, 'content-type': 'text/plain' },
        body: bytes,
      },
    );
    assertEquals(upload.status, 200);
    const { content_uri } = await upload.json();
    const path = `client/v1/media/download/${
      content_uri.slice('mxc://'.length)
    }`;
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
    const edgePort = await edge.port('client');
    const reply = await request(
      edgePort,
      'client/v3/login',
      json({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: credentials.username },
        password: credentials.password,
        device_id: 'media-wants',
      }),
    );
    const login = await reply.json();
    assertEquals(reply.status, 200, login.error);
    const headers = { authorization: `Bearer ${login.access_token}` };
    const download = () => request(edgePort, path, { headers });
    await Promise.all(Array.from({ length: 4 }, async () => {
      const miss = await download();
      assertEquals(miss.status, 503);
      await miss.body?.cancel();
    }));
    home = await startHome();
    const deadline = Date.now() + 8_000;
    for (;;) {
      const result = await download();
      if (result.status === 200) {
        assertEquals(await result.text(), bytes);
        assertEquals(result.headers.get('content-type'), 'text/plain');
        break;
      }
      await result.body?.cancel();
      if (Date.now() >= deadline) {
        assertEquals(
          result.status,
          200,
          'home check-in did not fulfill the legacy MXC',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});
