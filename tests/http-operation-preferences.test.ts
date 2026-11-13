import { assert, assertEquals } from '@std/assert';
import { serverName, setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { buildXMatrixHeader } from '#engine/federation/xmatrix.ts';
import { mediaMultipart } from '#engine/media/multipart.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { httpSuite } from '#tests/http-app.ts';
import {
  fedCaller,
  remoteServer,
  signerFor,
  signTemplate,
} from '#tests/http-federation.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP permitted operation preferences');
async function call(
  path: string,
  token: string,
  body?: Json,
  method = body === undefined ? 'GET' : 'POST',
) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method,
      headers: { authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}

suite.test('media waiting, redirect and animation preferences permit immediate static answers', async () => {
  const user = await suite.registerTestUser('preference-media', 'pw');
  const root = await Deno.makeTempDir({ prefix: 'operation-media-' });
  setConfigForTests({ media: { root } });
  try {
    const png = await Deno.readFile(
      new URL('fixtures/matrix.png', import.meta.url),
    );
    const upload = await suite.matrix(
      new Request('http://x/_matrix/media/v3/upload', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + user.access_token,
          'content-type': 'image/png',
        },
        body: png,
      }),
    );
    assertEquals(upload.status, 200);
    const mxc = String((await upload.json()).content_uri).slice(
      'mxc://'.length,
    );
    const id = mxc.split('/').at(-1)!;
    const peer = await remoteServer('preference-media.test');
    const signer = signerFor(peer);
    const get = async (path: string, federation: boolean) => {
      const authorization = federation
        ? buildXMatrixHeader({
          origin: peer.name,
          destination: serverName(),
          key: peer.keyId,
          signature: await signer.sign(
            canonicalJson({
              method: 'GET',
              uri: path,
              origin: peer.name,
              destination: serverName(),
            }),
          ),
        })
        : 'Bearer ' + user.access_token;
      const response = await suite.matrix(
        new Request('http://x' + path, { headers: { authorization } }),
      );
      assertEquals(response.status, 200, path);
      assertEquals(response.headers.has('Location'), false);
      if (!federation) return new Uint8Array(await response.arrayBuffer());
      const chunks: Uint8Array[] = [];
      const parser = mediaMultipart(
        response.headers.get('content-type')!,
        new WritableStream({
          write: (chunk) => {
            chunks.push(chunk);
          },
        }),
        100000,
      );
      await response.body!.pipeTo(parser.stream);
      const bytes = new Uint8Array(
        chunks.reduce((n, chunk) => n + chunk.length, 0),
      );
      let at = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, at);
        at += chunk.length;
      }
      assertEquals(parser.result.contentType, 'image/png');
      return bytes;
    };
    for (const timeout of [0, 20000]) {
      for (
        const base of [
          '/_matrix/client/v1/media',
          '/_matrix/media/v3',
          '/_matrix/federation/v1/media',
        ]
      ) {
        const federation = base.includes('/federation/');
        const tail = federation ? id : mxc;
        assertEquals(
          await get(
            base + '/download/' + tail + '?timeout_ms=' + timeout +
              '&allow_redirect=true',
            federation,
          ),
          png,
        );
        for (const animated of ['true', 'false']) {
          const bytes = await get(
            base + '/thumbnail/' + tail +
              '?width=8&height=8&method=scale&animated=' + animated +
              '&timeout_ms=' + timeout + '&allow_redirect=true',
            federation,
          );
          assertEquals([...bytes.slice(0, 8)], [
            137,
            80,
            78,
            71,
            13,
            10,
            26,
            10,
          ]);
          assertEquals(
            new TextDecoder().decode(bytes).includes('acTL'),
            false,
            'static PNG even when animation is offered',
          );
        }
      }
    }
  } finally {
    setConfigForTests({});
    await Deno.remove(root, { recursive: true });
  }
});

suite.test('preview time permits the current preview through both adapters', async () => {
  const user = await suite.registerTestUser('preference-preview', 'pw');
  const fake = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    () =>
      new Response('<html><head><title>Current preview</title></head></html>', {
        headers: { 'content-type': 'text/html' },
      }),
  );
  setConfigForTests({ preview: { enabled: true, allowlist: ['127.0.0.0/8'] } });
  try {
    const url = encodeURIComponent(
      'http://127.0.0.1:' + fake.addr.port + '/current',
    );
    for (const base of ['/_matrix/client/v1/media', '/_matrix/media/v3']) {
      const result = await call(
        base + '/preview_url?url=' + url + '&ts=1',
        user.access_token!,
      );
      assertEquals(result.status, 200);
      assertEquals(result.body['og:title'], 'Current preview');
    }
  } finally {
    setConfigForTests({});
    await fake.shutdown();
  }
});

suite.test('stored event projection and redundancy preferences preserve the permitted superset', async () => {
  const user = await suite.registerTestUser('preference-filter', 'pw');
  const base = '/_matrix/client/v3/user/' + encodeURIComponent(user.user_id) +
    '/filter';
  const filter = {
    event_fields: ['content.body'],
    room: {
      state: { lazy_load_members: true, include_redundant_members: true },
    },
  };
  const saved = await call(base, user.access_token!, filter);
  assertEquals(saved.status, 200);
  assertEquals(
    (await call(base + '/' + saved.body.filter_id, user.access_token!)).body,
    filter,
  );
  const made = await call(
    '/_matrix/client/v3/createRoom',
    user.access_token!,
    {},
  );
  assertEquals(made.status, 200);
  const sync = await call(
    '/_matrix/client/v3/sync?timeout=0&filter=' + saved.body.filter_id,
    user.access_token!,
  );
  const room = (((sync.body.rooms as Json).join as Json)[
    String(made.body.room_id)
  ]) as Json;
  const events = [
    ...(room.state as Json).events as Json[],
    ...(room.timeline as Json).events as Json[],
  ];
  assert(
    events.some((event) =>
      event.type === 'm.room.member' && event.state_key === user.user_id
    ),
  );
  assert(
    events.every((event) =>
      event.content !== undefined && event.event_id !== undefined
    ),
    'extra envelope fields are allowed',
  );
});

suite.test('registration refresh_token declares support but does not require a refresh token', async () => {
  const body = { password: 'pw', refresh_token: true };
  const challenge = await call('/_matrix/client/v3/register', '', body);
  assertEquals(challenge.status, 401);
  const registered = await call('/_matrix/client/v3/register', '', {
    ...body,
    auth: { type: 'm.login.dummy', session: challenge.body.session },
  });
  assertEquals(registered.status, 200);
  assertEquals('refresh_token' in registered.body, false);
  const who = await call(
    '/_matrix/client/v3/account/whoami',
    String(registered.body.access_token),
  );
  assertEquals(who.body.user_id, registered.body.user_id);
});

suite.test('disabled login credentials never fall through to a password session', async () => {
  const user = await suite.registerTestUser('preference-login-branches', 'pw');
  const before = await call('/_matrix/client/v3/devices', user.access_token!);
  const attempts = [
    { type: 'm.login.token', token: 'unused-token' },
    {
      type: 'm.login.password',
      identifier: {
        type: 'm.id.thirdparty',
        medium: 'email',
        address: 'nobody@example.test',
      },
      password: 'pw',
    },
    {
      type: 'm.login.password',
      identifier: { type: 'm.id.phone', country: 'GB', phone: '12345' },
      password: 'pw',
    },
    {
      type: 'm.login.password',
      medium: 'email',
      address: 'nobody@example.test',
      password: 'pw',
    },
  ];
  for (const body of attempts) {
    const result = await call('/_matrix/client/v3/login', '', {
      ...body,
      device_id: 'MUST-NOT-EXIST',
    });
    assertEquals(result.status, 400);
    assertEquals('access_token' in result.body, false);
  }
  assertEquals(
    (await call('/_matrix/client/v3/devices', user.access_token!)).body,
    before.body,
  );
});

suite.test('search ignores sync-only and lazy-loading preferences without changing its admitted results', async () => {
  const user = await suite.registerTestUser('preference-search', 'pw');
  const made = await call(
    '/_matrix/client/v3/createRoom',
    user.access_token!,
    {},
  );
  assertEquals(made.status, 200);
  const room = String(made.body.room_id);
  const sent = await call(
    '/_matrix/client/v3/rooms/' + encodeURIComponent(room) +
      '/send/m.room.message/preference',
    user.access_token!,
    { msgtype: 'm.text', body: 'preference-needle' },
    'PUT',
  );
  assertEquals(sent.status, 200);
  const search = async (filter: Json) => {
    const result = await call('/_matrix/client/v3/search', user.access_token!, {
      search_categories: {
        room_events: {
          search_term: 'preference-needle',
          include_state: true,
          filter: { rooms: [room], ...filter },
        },
      },
    });
    assertEquals(result.status, 200);
    const events = (result.body.search_categories as Json).room_events as Json;
    // age is measured at response time, not part of the selected state cut.
    for (
      const event of Object.values(events.state as Record<string, Json[]>)
        .flat()
    ) {
      if (event.unsigned !== undefined) delete (event.unsigned as Json).age;
    }
    return {
      count: events.count,
      ids: (events.results as Json[]).map((entry) =>
        (entry.result as Json).event_id
      ),
      state: events.state,
    };
  };
  const baseline = await search({});
  assertEquals(baseline.count, 1);
  assertEquals(baseline.ids, [sent.body.event_id]);
  for (const value of [false, true]) {
    assertEquals(
      await search({
        unread_thread_notifications: value,
        lazy_load_members: value,
        include_redundant_members: value,
      }),
      baseline,
    );
  }
});

suite.test('send_join may return the full snapshot when omit_members is offered', async () => {
  const user = await suite.registerTestUser('preference-join', 'pw');
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: true,
      allowunencryptedjoining: true,
    },
  });
  try {
    const made = await call(
      '/_matrix/client/v3/createRoom',
      user.access_token!,
      { preset: 'public_chat' },
    );
    assertEquals(made.status, 200);
    const peer = await remoteServer('preference-join.test');
    const fed = fedCaller(suite.matrix, peer);
    const id = encodeURIComponent(String(made.body.room_id));
    const template = await fed(
      'GET',
      '/_matrix/federation/v1/make_join/' + id + '/' +
        encodeURIComponent('@joining:' + peer.name) + '?ver=11',
    );
    assertEquals(template.status, 200);
    const join = await signTemplate(template.body.event as Json, peer);
    const result = await fed(
      'PUT',
      '/_matrix/federation/v2/send_join/' + id + '/' +
        encodeURIComponent(String(join.event_id)) + '?omit_members=true',
      toWire(join, '11'),
    );
    assertEquals(result.status, 200);
    assert(
      Array.isArray(result.body.state) &&
        result.body.state.some((event: Json) => event.type === 'm.room.member'),
    );
    assert(Array.isArray(result.body.auth_chain));
  } finally {
    setConfigForTests({});
  }
});
