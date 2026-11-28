import { assert, assertEquals, assertRejects } from '@std/assert';
import { adminCall } from './admin-client.ts';
import { facadeProcess } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { facadeTls } from './support/facade-tls.ts';

async function proveCopy(faults: boolean) {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  const server = 'logical.test';
  const node = 'edge_a';
  const facadeReady = 'facade: link/local admin ready';
  const homeReady = 'federation: enabled';
  const control = `${file('home')}.media-copy`;
  const phase = async (name: string) => {
    await Deno.writeTextFile(`${control}.next`, name);
    await Deno.rename(`${control}.next`, control);
  };
  const trace = async () =>
    (await Deno.readTextFile(`${control}.trace`)).trim().split('\n');
  const until = async (predicate: () => Promise<boolean>, label: string) => {
    const deadline = Date.now() + 10_000;
    do {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error(`media-copy deadline: ${label}`);
  };
  const seen = (prefix: string) =>
    until(
      async () => (await trace()).some((line) => line.startsWith(prefix)),
      prefix,
    );
  const startHome = () =>
    facadeProcess(
      file('home'),
      homeReady,
      [],
      faults ? { entrypoint: 'tests/fixtures/media-copy-child.ts' } : {},
    );
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
    if (faults) {
      await phase('legacy-peer');
      await Deno.writeTextFile(`${control}.trace`, '');
    }
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="${server}"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\n` +
          `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${side}.crt"\nkey="${tls.dir}/${side}.key"\n` +
          `[facade]\nphase="f2"\nnodeid="${node}"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
          (faults ? 'batchmaxbytes=8192\n' : '') +
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
    home = await startHome();
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
    const bytes = 'offline upload\n'.repeat(faults ? 1500 : 100_000);
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
    home = await startHome();
    homePort = await home.port('client');
    if (faults) {
      const id = content_uri.split('/').at(-1);
      const final = `${tls.dir}/home-media/${id}`;
      const part = `${final}.home-copy.part`;
      const original = `${tls.dir}/facade-media/${id}`;
      const edgeInode = (await Deno.stat(original)).ino;
      const invisible = async () => {
        const read = await request(homePort, path, { headers: homeAuth });
        await read.body?.cancel();
        assertEquals(read.status, 503);
        await assertRejects(() => Deno.stat(final), Deno.errors.NotFound);
      };

      // The old capability set still reconciles for at least two full wakes
      // with an outstanding facade original, without a media request or ACK.
      const initialHellos = (await trace()).filter((line) =>
        line.startsWith('legacy-peer:hello')
      ).length;
      await until(
        async () =>
          (await trace()).filter((line) => line.startsWith('legacy-peer:hello'))
            .length >= initialHellos + 2,
        'legacy hello with queued original',
      );
      assert(
        !(await trace()).some((line) => line.startsWith('legacy-peer:media-')),
      );
      await assertRejects(() => Deno.stat(final), Deno.errors.NotFound);
      await assertRejects(() => Deno.stat(part), Deno.errors.NotFound);

      for (const fault of ['order', 'digest', 'fingerprint']) {
        await phase(fault);
        await seen(`${fault}:manifests 0`); // entire attempted pass finished
        assert((await trace()).includes(`${fault}:media-chunk 0`));
        assert(
          !(await trace()).some((line) =>
            line.startsWith(`${fault}:media-applied`)
          ),
        );
        assertEquals((await Deno.stat(part)).size, 0);
        await invisible();
      }

      await phase('cut');
      let cut = 0;
      await until(async () => {
        cut = Number(
          (await trace()).find((line) => /^cut:media-chunk [1-9]/.test(line))
            ?.split(' ')[1],
        );
        return cut > 0;
      }, 'interrupted nonzero chunk');
      assert(cut < bytes.length);
      assertEquals((await Deno.stat(part)).size, cut);
      await invisible();

      // An unrelated device change still propagates while the chunk is held.
      const otherLogin = await request(
        homePort,
        'client/v3/login',
        json({
          type: 'm.login.password',
          identifier: { type: 'm.id.user', user: credentials.username },
          password: credentials.password,
          device_id: 'during-media-copy',
        }),
      );
      await otherLogin.body?.cancel();
      assertEquals(otherLogin.status, 200);
      await until(async () => {
        const devices = await request(edgePort, 'client/v3/devices', {
          headers: edgeAuth,
        });
        const body = await devices.json();
        return devices.status === 200 &&
          body.devices.some((device: { device_id: string }) =>
            device.device_id === 'during-media-copy'
          );
      }, 'device stream while media chunk is held');
      await invisible();

      await home.stop();
      // Model bytes written before a cut was committed; restart may only
      // retain the verified prefix, not trust the physical file length.
      await Deno.writeTextFile(part, 'uncommitted tail', { append: true });
      await phase('manifest');
      home = await startHome();
      homePort = await home.port('client');
      await seen('manifest:manifests 0');
      assert(
        !(await trace()).some((line) =>
          /^manifest:media-(chunk|applied)/.test(line)
        ),
      );
      await invisible();

      await phase('resume');
      await seen('resume:media-applied');
      const resumed = (await trace()).filter((line) =>
        line.startsWith('resume:media-chunk')
      );
      assertEquals(resumed[0], `resume:media-chunk ${cut}`);
      assert(resumed.length > 1);
      const homeInode = (await Deno.stat(final)).ino;
      assertEquals(
        await (await request(homePort, path, { headers: homeAuth })).text(),
        bytes,
      );

      await phase('legacy-ack');
      await seen('legacy-ack:409:LINK_CAPABILITY_MISMATCH');
      await phase('retry');
      await seen('retry:media-applied');
      // An empty scan from the beginning proves the ACK actually reached the
      // facade; the page after an ACK would be empty irrespective of that.
      await seen('retry:start 0');
      const retried = (await trace()).filter((line) =>
        line.startsWith('retry:')
      );
      assertEquals(
        retried.filter((line) => line === 'retry:start 1').length,
        1,
      );
      assert(!retried.some((line) => line.startsWith('retry:media-chunk')));
      assertEquals((await Deno.stat(final)).ino, homeInode);
      await assertRejects(() => Deno.stat(part), Deno.errors.NotFound);
      assertEquals((await Deno.stat(original)).ino, edgeInode);
      assertEquals(
        await (await request(edgePort, path, { headers: edgeAuth })).text(),
        bytes,
      );
    }
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
    home = await startHome();
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
}

Deno.test('04-media-copy: an acknowledged offline upload arrives at cold home', () =>
  proveCopy(false));
Deno.test('04-media-copy: interrupted transfer rejects bad data and retries only verified cuts and negotiated ACKs', () =>
  proveCopy(true));
