import { assert, assertEquals, assertRejects } from '@std/assert';
import { capabilities } from '#engine/facade/capabilities.ts';
import { setConfigForTests } from '#engine/config.ts';
import { newMediaId } from '#engine/media.ts';
import { signJson } from '#engine/signing-primitives.js';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { createMedia, getMedia } from '#engine/tenant/media.ts';
import { adminCall } from './admin-client.ts';
import { makeServer, seedServer } from './federation/doc-helper.ts';
import { facadeProcess as process } from './helpers/facade-process.ts';
import { fixtureLink } from './helpers/fixture-listeners.ts';
import { mediaPublicationOverlay } from './helpers/media-publication.ts';
import { facadeTls } from './support/facade-tls.ts';

async function waitForMediaPublication(
  name: string,
  hold: { held(signal?: AbortSignal): Promise<unknown> },
  response: Promise<Response>,
  timeoutMs = 20_000,
): Promise<void> {
  const observation = new AbortController();
  const timer = setTimeout(() => {
    observation.abort(
      new Error(`deadline waiting for publication cut ${name}`),
    );
  }, timeoutMs);
  try {
    const first = await Promise.race([
      hold.held(observation.signal).then(() => null),
      response,
    ]);
    if (first) {
      throw new Error(`before publication cut ${name}: HTTP ${first.status}`);
    }
  } catch (error) {
    // No caller consumes an HTTP body on this path, even if it arrives late.
    // Don't wait on stream cancellation to report the original failure.
    void response.then((res) => res.body?.cancel()).catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
    observation.abort();
  }
}

async function withMediaCleanup(
  run: () => Promise<void>,
  cleanup: (() => Promise<void> | undefined)[],
): Promise<void> {
  const failures: unknown[] = [];
  try {
    await run();
  } catch (error) {
    failures.push(error);
  }
  for (const release of cleanup) {
    try {
      await release();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, 'media fixture failed', {
      cause: failures[0],
    });
  }
}

Deno.test('single facade media R1: publication waits report early HTTP results and missing cuts', async () => {
  const never = Promise.withResolvers<never>().promise;
  let observing: AbortSignal | undefined;
  const missing = {
    held: (signal?: AbortSignal) =>
      signal
        ? new Promise<never>((_, reject) => {
          observing = signal;
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        })
        : never,
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('test watchdog expired')), 1000);
  });
  try {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { status: 503 },
    );
    await assertRejects(
      () =>
        Promise.race([
          waitForMediaPublication(
            'before-install',
            missing,
            Promise.resolve(response),
          ),
          watchdog,
        ]),
      Error,
      'HTTP 503',
    );
    assert(cancelled);
    assert(observing?.aborted, 'the losing observation must be cancelled');
    await assertRejects(
      () =>
        Promise.race([
          waitForMediaPublication('file-sync', missing, never, 0),
          watchdog,
        ]),
      Error,
      'deadline waiting for publication cut file-sync',
    );
    const late = Promise.withResolvers<Response>();
    await waitForMediaPublication('install', {
      held: () => Promise.resolve(),
    }, late.promise);
    late.resolve(new Response('ack'));
    assertEquals(await (await late.promise).text(), 'ack');
  } finally {
    clearTimeout(timer);
  }
});

Deno.test('single facade media R1: cleanup visits every resource and keeps both failures', async () => {
  const primary = new Error('assertion failed');
  const disposal = new Error('home disposal failed');
  const calls: string[] = [];
  const error = await assertRejects(() =>
    withMediaCleanup(() => Promise.reject(primary), [
      () => {
        calls.push('probe');
        return Promise.resolve();
      },
      () => {
        calls.push('home');
        return Promise.reject(disposal);
      },
      () => {
        calls.push('edge');
        return Promise.resolve();
      },
      () => {
        calls.push('files');
        return Promise.resolve();
      },
    ])
  );
  assertEquals(calls, ['probe', 'home', 'edge', 'files']);
  assert(error instanceof AggregateError);
  assert(error.errors[0] === primary && error.errors[1] === disposal);
});

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
      undefined,
    );
  }
});

Deno.test('single facade media: offline wire upload and signed cold read', async (test) => {
  const tls = await facadeTls();
  const file = (side: string) => `${tls.dir}/${side}.toml`;
  const socket = (side: string) => `${tls.dir}/${side}.sock`;
  const bundlefile = `${tls.dir}/bundle.json`;
  let edge: Awaited<ReturnType<typeof process>> | undefined;
  let home: Awaited<ReturnType<typeof process>> | undefined;
  let homeProbe: Deno.HttpServer | undefined;
  async function exercise() {
    setConfigForTests({ server: { name: 'logical.test' } });
    const remote = await makeServer('media-peer.test');
    for (const side of ['home', 'facade']) {
      await Deno.writeTextFile(
        file(side),
        `[server]\nname="logical.test"\nrole="${side}"\nport=0\n` +
          `[store]\ndir="${tls.dir}/${side}-store"\n` +
          `[admin]\nsocket="${socket(side)}"\n` +
          `[media]\nroot="${tls.dir}/${side}-media"\nmaxbytes=64\n` +
          `[preview]\nenabled=true\nblocklist=[]\nallowlist=["127.0.0.0/8"]\n` +
          `[federation]\nenabled=true\nport=0\ncert="${tls.dir}/${side}.crt"\nkey="${tls.dir}/${side}.key"\n` +
          `[facade]\nphase="f2"\nnodeid="edge_a"\nurl="https://127.0.0.1:0"\nlinkport=0\nlinkcert="${tls.dir}/${side}.crt"\nlinkkey="${tls.dir}/${side}.key"\nlinkcacerts=["${tls.dir}/ca.crt"]\npollseconds=1\nreconnectmaxseconds=1\n` +
          (side === 'home'
            ? `nodes=["edge_a"]\npairfile="${bundlefile}"\n`
            : ''),
      );
    }
    const facadeStore = () =>
      openStore({
        dir: `${tls.dir}/facade-store`,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { server: serverSchema, tenant: tenantSchema } });
    const outbound = async (store: Awaited<ReturnType<typeof facadeStore>>) =>
      await (await store.server()).query(
        "SELECT * FROM facade_streams WHERE direction='out' ORDER BY peer,source,incarnation,stream",
      );
    const seed = await facadeStore();
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
    for (const username of [credentials.username, 'other-owner']) {
      const registration = await register({ ...credentials, username });
      assertEquals(registration.status, 401);
      const enrolled = await register({
        ...credentials,
        username,
        auth: {
          type: 'm.login.dummy',
          session: (await registration.json()).session,
        },
      });
      assertEquals(enrolled.status, 200);
      await enrolled.body?.cancel();
    }
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
    for (const username of [credentials.username, 'other-owner']) {
      for (const stream of ['auth', 'key-bootstrap', 'devices']) {
        await edge.observations.fact({
          peer: 'home',
          source: 'home',
          incarnation: paired.body.result.id,
          stream: `${stream}:@${username}:logical.test`,
        }, () => true);
      }
    }
    let port = await edge.port('client');
    await home.stop();
    await assertRejects(() =>
      Deno.connect({ hostname: '127.0.0.1', port: homePort })
    );
    await edge.stop();
    setConfigForTests({
      server: { name: 'logical.test', role: 'facade' },
      facade: { nodeid: 'edge_b' },
    });
    const foreignId = newMediaId();
    setConfigForTests({ server: { name: 'logical.test' } });
    const disconnected = await facadeStore();
    try {
      const tenant = await openTenant(disconnected, 'logical.test');
      // Make the issuer check discriminating: same tenant, correct user,
      // durable unexpired reservation, but minted by a different edge.
      await createMedia(tenant, credentials.username, foreignId, 'pending');
    } finally {
      await disconnected.close();
    }
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
    const loginAtEdge = async (username: string) => {
      const login = await fetch(
        `http://127.0.0.1:${port}/_matrix/client/v3/login`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: username },
            password: credentials.password,
            device_id: 'offline-media',
          }),
        },
      );
      const session = await login.json();
      assertEquals(login.status, 200, login.ok ? undefined : session.error);
      return session.access_token as string;
    };
    const token = await loginAtEdge(credentials.username);
    const other = await loginAtEdge('other-owner');
    // Login publishes device authority; take the baseline after both logins,
    // before any media requests, with no writer sharing the store.
    await edge.stop();
    const before = await facadeStore();
    const outboundBefore = await outbound(before).finally(() => before.close());
    const seen: string[] = [];
    homeProbe = Deno.serve({
      hostname: '127.0.0.1',
      port: homePort,
      onListen() {},
    }, (r) => {
      seen.push(new URL(r.url).pathname);
      return new Response('probe');
    });
    const target = `127.0.0.1:${homePort}`;
    assertEquals(await (await fetch(`http://${target}/probe`)).text(), 'probe');
    edge = await process(file('facade'), 'facade: link/local admin ready');
    port = await edge.port('client');
    const request = (
      path: string,
      method = 'GET',
      body?: string,
      auth = true,
      acting = token,
    ) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: {
          ...(auth ? { authorization: 'Bearer ' + acting } : {}),
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
    await test.step('wrong owner cannot fill a live local reservation', async () => {
      const result = await request(put, 'PUT', 'wrong', true, other);
      assertEquals([result.status, (await result.json()).errcode], [
        403,
        'M_FORBIDDEN',
      ]);
    });
    await test.step('wrong issuer cannot fill even a durable own reservation', async () => {
      const result = await request(
        media + '/upload/logical.test/' + foreignId,
        'PUT',
        'wrong',
      );
      assertEquals([result.status, (await result.json()).errcode], [
        404,
        'M_NOT_FOUND',
      ]);
    });
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

    await test.step('private addresses cannot be dialed or queue home work', async () => {
      for (const route of ['download', 'thumbnail']) {
        const result = await request(
          `/_matrix/client/v1/media/${route}/${target}/${directId}?width=32&height=32`,
        );
        assertEquals([result.status, (await result.json()).errcode], [
          502,
          'M_UNKNOWN',
        ]);
      }
      for (const route of ['client/v1/media', 'media/v3']) {
        const path = `/_matrix/${route}/preview_url?url=${
          encodeURIComponent(`http://${target}/preview`)
        }`;
        const result = await request(path);
        assertEquals([result.status, (await result.json()).errcode], [
          403,
          'M_FORBIDDEN',
        ]);
        const anonymous = await request(path, 'GET', undefined, false);
        assertEquals(anonymous.status, 401);
        await anonymous.body?.cancel();
      }
      await edge!.stop();
      await homeProbe!.shutdown();
      homeProbe = undefined;
      assertEquals(seen, ['/probe']);
      const after = await facadeStore();
      try {
        assertEquals(await outbound(after), outboundBefore);
        assertEquals(
          await (await after.server()).query(
            'SELECT address FROM facade_home_addresses ORDER BY address',
          ),
          [{ address: '127.0.0.1' }],
        );
        assertEquals(
          (await getMedia(await openTenant(after, 'logical.test'), foreignId))
            ?.state,
          'pending',
        );
      } finally {
        await after.close();
      }
    });

    const ready = 'facade: link/local admin ready';
    const importMap = await mediaPublicationOverlay(tls.dir);
    const mediaRoot = `${tls.dir}/facade-media`;
    const restart = async (hold?: string) => {
      await edge?.stop();
      edge = await process(file('facade'), ready, hold ? [hold] : [], {
        importMap: hold ? importMap : undefined,
      });
      port = await edge.port('client');
      return edge;
    };
    const newReservation = async () => {
      const response = await request(reserve, 'POST');
      assertEquals(response.status, 200);
      return (await response.json()).content_uri.slice(prefix.length) as string;
    };
    assert(
      await test.step('installation cannot overwrite a final that already exists', async () => {
        const child = await restart('before-install');
        const cut = await child.holdPublication('before-install');
        const id = await newReservation();
        const pending = request(
          media + '/upload/logical.test/' + id,
          'PUT',
          'candidate',
        );
        await waitForMediaPublication('before-install', cut, pending);
        const final = `${mediaRoot}/${id}`;
        await Deno.writeTextFile(final, 'incumbent', { createNew: true });
        await cut.release();
        const response = await pending;
        await response.body?.cancel();
        assertEquals(await Deno.readTextFile(final), 'incumbent');
        assertEquals(response.status, 503);
        await Deno.remove(final);
      }),
    );
    const acked = new Map([[directId, 'direct bytes'], [
      pendingId,
      'reserved bytes',
    ]]);
    for (
      const cutName of [
        'file-sync',
        'install',
        'metadata-insert',
        'metadata-update',
        'intent',
        'before-response',
        'after-response',
      ]
    ) {
      assert(
        await test.step(`SIGKILL at ${cutName}`, async () => {
          const after = cutName === 'after-response';
          const child = await restart(after ? undefined : cutName);
          const hold = after ? undefined : await child.holdPublication(cutName);
          let id = cutName === 'metadata-insert' ? '' : await newReservation();
          const body = `bytes at ${cutName}`;
          const filling = id !== '';
          const result = request(
            filling ? media + '/upload/logical.test/' + id : media + '/upload',
            filling ? 'PUT' : 'POST',
            body,
          );
          // Handle the expected disconnect immediately; assert it after the kill.
          result.catch(() => {});
          if (after) {
            const response = await result;
            assertEquals(response.status, 200);
            assertEquals(await response.json(), {});
            acked.set(id, body);
          } else {
            await waitForMediaPublication(cutName, hold!, result);
            if (!filling) {
              const files = [];
              for await (const entry of Deno.readDir(mediaRoot)) {
                if (entry.isFile && !acked.has(entry.name)) {
                  files.push(entry.name);
                }
              }
              assertEquals(files.length, 1);
              id = files[0];
            }
          }
          await child.crash();
          edge = undefined;
          if (!after) await assertRejects(() => result);
          await restart();
          for (const [ack, bytes] of acked) {
            const response = await request(download + ack);
            assertEquals(response.status, 200, ack);
            assertEquals(await response.text(), bytes);
          }
          if (!after) {
            const response = await request(download + id);
            if (cutName === 'before-response') {
              // Commit succeeded but the caller did not see its ACK.
              assertEquals(response.status, 200);
              assertEquals(await response.text(), body);
              acked.set(id, body);
            } else {
              assertEquals(response.status, filling ? 504 : 404);
              await response.body?.cancel();
            }
          }
          const originals = [];
          for await (const entry of Deno.readDir(mediaRoot)) {
            if (entry.isFile) originals.push(entry.name);
          }
          assertEquals(originals.sort(), [...acked.keys()].sort());
        }),
      );
    }
  }
  await withMediaCleanup(exercise, [
    () => homeProbe?.shutdown(),
    () => home?.dispose(),
    () => edge?.dispose(),
    () => tls.close(),
  ]);
});
