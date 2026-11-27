import { assertEquals, assertRejects } from '@std/assert';
import { adminCall } from './admin-client.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { facadeTls } from './support/facade-tls.ts';

async function until<T>(read: () => Promise<T | undefined>, why: string) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const result = await read();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) throw new Error(why);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const maybeText = (path: string) =>
  Deno.readTextFile(path).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return undefined;
  });

Deno.test('05-media-wants: home fulfills a legacy MXC and refills an evicted upload', async () => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const server = 'logical.test';
  const node = 'edge_a';
  const observe = { entrypoint: 'tests/fixtures/media-wants-child.ts' };
  const startHome = () =>
    facadeProcess(file('home'), 'federation: enabled', [], observe);
  const startEdge = () =>
    facadeProcess(
      file('facade'),
      'facade: link/local admin ready',
      [],
      observe,
    );
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
            : 'storagebudgetbytes=67108864\n'),
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
    const uploadAtEdge = async (body: string) => {
      const result = await request(
        edgePort,
        'media/v3/upload?filename=edge.txt',
        {
          method: 'POST',
          headers: { ...headers, 'content-type': 'text/plain' },
          body,
        },
      );
      assertEquals(result.status, 200);
      return String((await result.json()).content_uri).slice('mxc://'.length);
    };
    const edgeBytes = 'facade upload backed by home\n'.repeat(12_000);
    const confirmed = await uploadAtEdge(edgeBytes);
    const id = confirmed.split('/')[1];
    await Promise.all(Array.from({ length: 4 }, async () => {
      const miss = await download();
      assertEquals(miss.status, 503);
      await miss.body?.cancel();
    }));
    home = await startHome();
    const served = async (load: () => Promise<Response>, body: string) => {
      await until(async () => {
        const result = await load();
        if (result.status !== 200) {
          assertEquals(result.status, 503);
          await result.body?.cancel();
          return;
        }
        assertEquals(await result.text(), body);
        assertEquals(result.headers.get('content-type'), 'text/plain');
        return true;
      }, 'home check-in did not fulfill the wanted MXC');
    };
    await served(download, bytes);
    await until(
      async () =>
        (await maybeText(`${file('home')}.media-wants.applied`))?.split('\n')
          .includes(id) || undefined,
      'home did not confirm the facade upload',
    );
    await home.stop();
    const unconfirmed = await uploadAtEdge('not yet retained at home');
    const media = `${tls.dir}/facade-media`;
    const original = `${media}/${id}`;
    const load = () =>
      request(edgePort, `client/v1/media/download/${confirmed}`, { headers });
    await edge.stop();
    edge = await startEdge();
    assertEquals(await edge.port('client'), edgePort);
    const control = `${file('facade')}.media-wants`;
    await Deno.writeTextFile(`${control}.pressure`, `${media}/pressure.part`);
    assertEquals(
      await until(
        () => maybeText(`${control}.pressure-result`),
        'no admission result',
      ),
      'admitted',
      'shared pressure did not reclaim a home-confirmed facade upload',
    );
    await assertRejects(() => Deno.stat(original), Deno.errors.NotFound);
    assertEquals(
      await Deno.readTextFile(`${media}/${unconfirmed.split('/')[1]}`),
      'not yet retained at home',
    );
    const missing = await load();
    assertEquals(missing.status, 503);
    assertEquals(
      (await missing.json()).error,
      'Media unavailable; try again later',
    );
    home = await startHome();
    await served(load, edgeBytes);
  } finally {
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});
