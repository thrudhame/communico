import { assert, assertEquals, assertRejects } from '@std/assert';
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

type Demand = { id: string; demand: string };
type Trace = Partial<Demand> & {
  route: string;
  offset?: number;
  wanted?: Demand[];
};

Deno.test('05-media-wants: home fulfills a legacy MXC and refills an evicted upload', async () => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const server = 'logical.test';
  const node = 'edge_a';
  const observe = { entrypoint: 'tests/fixtures/media-wants-child.ts' };
  const startHome = (holds: string[] = []) =>
    facadeProcess(file('home'), 'federation: enabled', holds, observe);
  const startEdge = (holds: string[] = []) =>
    facadeProcess(
      file('facade'),
      'facade: link/local admin ready',
      holds,
      observe,
    );
  const request = (port: number, path: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}/_matrix/${path}`, {
      signal: AbortSignal.timeout(15_000),
      ...init,
    });
  const control = `${file('facade')}.media-wants`;
  const homeControl = `${file('home')}.media-wants`;
  const trace = async (): Promise<Trace[]> =>
    ((await maybeText(`${homeControl}.trace`)) ?? '').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line));
  const json = (value: unknown) => ({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  });
  const credentials = { username: 'owner', password: 'media-wants-password' };
  const cancel = new AbortController();
  let home: Awaited<ReturnType<typeof startHome>> | undefined;
  let edge: Awaited<ReturnType<typeof startEdge>> | undefined;
  try {
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="${server}"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\ntimeoutms=5000\n` +
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
    const legacy = String(content_uri).split('/').at(-1)!;
    const path = `client/v1/media/download/${
      content_uri.slice('mxc://'.length)
    }`;
    const reservation = await request(homePort, 'media/v1/create', {
      method: 'POST',
      headers: homeAuth,
    });
    assertEquals(reservation.status, 200);
    const pendingPath = `client/v1/media/download/${
      String((await reservation.json()).content_uri).slice('mxc://'.length)
    }`;
    const absentPath = `client/v1/media/download/${server}/not-an-upload`;
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
    const expect503 = async (result: Response) => {
      assertEquals(result.status, 503);
      assertEquals((await result.json()).errcode, 'M_UNAVAILABLE');
    };
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
    const media = `${tls.dir}/facade-media`;
    const staged = `${media}/${legacy}.wanted.part`;
    const installed = `${media}/${legacy}`;

    // The canceled client alone enrolls this demand. Hold the second push so
    // cancellation, duplicates, and the loss all happen with the transfer open.
    home = await startHome(['wanted-partial']);
    const partial = await home.holdPublication('wanted-partial');
    const reader = await edge.holdPublication('wanted-reader');
    const canceled = assertRejects(
      () => request(edgePort, path, { headers, signal: cancel.signal }),
      DOMException,
      'aborted',
    );
    void canceled.catch(() => {});
    const cut = await until(
      async () => (await trace()).find(({ offset }) => offset && offset > 0),
      'home check-in did not start fulfilling the legacy MXC',
    );
    await partial.held();
    await reader.held();
    cancel.abort();
    await canceled;
    await reader.release();
    assertEquals(cut.id, legacy);
    assertEquals((await Deno.stat(staged)).size, cut.offset);
    await assertRejects(() => Deno.stat(installed), Deno.errors.NotFound);
    await home.crash();
    await Promise.all(Array.from({ length: 24 }, async () => {
      await expect503(await download());
    }));

    // No new client request can recreate the want after this restart. Verify
    // the first replay advertises one identical demand and resumes at the cut.
    const mark = (await trace()).length;
    await edge.crash();
    edge = await startEdge(['wanted-install']);
    assertEquals(await edge.port('client'), edgePort);
    const install = await edge.holdPublication('wanted-install');
    home = await startHome();
    await install.held();
    const replay = (await trace()).slice(mark);
    assertEquals(replay.flatMap(({ wanted }) => wanted ?? []), [
      { id: legacy, demand: cut.demand },
    ]);
    const first = replay.find(({ offset }) => offset !== undefined);
    assertEquals(first?.offset, cut.offset);
    assertEquals(first?.demand, cut.demand);
    assertEquals((await Deno.stat(staged)).size, bytes.length);
    await assertRejects(() => Deno.stat(installed), Deno.errors.NotFound);
    await home.crash();
    await install.release();

    const exact = async (result: Response, body: string) => {
      assertEquals(result.status, 200);
      assertEquals(await result.text(), body);
      assertEquals(result.headers.get('content-type'), 'text/plain');
    };
    await exact(await download(), bytes);
    await expect503(await request(edgePort, absentPath, { headers }));
    await expect503(await request(edgePort, pendingPath, { headers }));
    home = await startHome();
    for (
      const [wantedPath, status, errcode] of [
        [absentPath, 404, 'M_NOT_FOUND'],
        [pendingPath, 504, 'M_NOT_YET_UPLOADED'],
      ] as const
    ) {
      await until(async () => {
        const result = await request(edgePort, wantedPath, { headers });
        if (result.status === 503) {
          await expect503(result);
          return;
        }
        assertEquals(result.status, status);
        assertEquals((await result.json()).errcode, errcode);
        return true;
      }, `no authoritative ${status} for ${wantedPath}`);
    }
    const served = async (load: () => Promise<Response>, body: string) => {
      await until(async () => {
        const result = await load();
        if (result.status !== 200) {
          assertEquals(result.status, 503);
          await result.body?.cancel();
          return;
        }
        await exact(result, body);
        return true;
      }, 'home check-in did not fulfill the wanted MXC');
    };
    await until(
      async () =>
        (await maybeText(`${homeControl}.applied`))?.split('\n')
          .includes(id) || undefined,
      'home did not confirm the facade upload',
    );
    await home.stop();
    const unconfirmed = await uploadAtEdge('not yet retained at home');
    const original = `${media}/${id}`;
    const load = () =>
      request(edgePort, `client/v1/media/download/${confirmed}`, { headers });
    await edge.stop();
    edge = await startEdge();
    assertEquals(await edge.port('client'), edgePort);
    const pressure = async () => {
      await Deno.writeTextFile(`${control}.pressure`, `${media}/pressure.part`);
      const result = await until(
        () => maybeText(`${control}.pressure-result`),
        'no admission result',
      );
      await Deno.remove(`${control}.pressure-result`);
      return result;
    };
    const lease = await edge.holdPublication(`original-lease:${id}`);
    const pinned = load();
    void pinned.catch(() => {});
    try {
      await lease.held();
      assertEquals(await pressure(), 'pressure');
      assert((await Deno.stat(original)).isFile);
    } finally {
      await lease.release();
    }
    await exact(await pinned, edgeBytes);
    assertEquals(
      await pressure(),
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
    assertEquals(
      await maybeText(`${control}.trace`),
      undefined,
      'facade attempted to initiate an outbound pair link',
    );
  } finally {
    cancel.abort();
    await home?.dispose();
    await edge?.dispose();
    await tls.close();
  }
});
