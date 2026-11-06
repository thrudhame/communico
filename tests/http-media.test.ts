// doltgres media wire assertions over the real loopback HTTP listener.
import { assert, assertEquals } from '@std/assert';
import { config, serverName, setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';
import { getMedia } from '#engine/tenant/media.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP media');
function test(name: string, fn: (root: string) => Promise<void>) {
  suite.test(name, async () => {
    const root = await Deno.makeTempDir({ prefix: 'http-media-' });
    const previous = config().media;
    setConfigForTests({ media: { root, maxbytes: 64 } });
    try {
      await fn(root);
    } finally {
      setConfigForTests({ media: previous });
      await Deno.remove(root, { recursive: true });
    }
  });
}
const request = (
  path: string,
  token?: string,
  method = 'GET',
  body?: Uint8Array,
  contentType?: string,
) => {
  const headers = new Headers();
  if (token !== undefined) headers.set('Authorization', 'Bearer ' + token);
  if (contentType !== undefined) headers.set('Content-Type', contentType);
  return suite.matrix(
    new Request('http://x' + path, {
      method,
      headers,
      body: body as BodyInit | undefined,
    }),
  );
};
const upload = (
  token: string,
  bytes: Uint8Array,
  contentType: string,
  filename?: string,
) =>
  request(
    '/_matrix/media/v3/upload' +
      (filename === undefined
        ? ''
        : '?filename=' + encodeURIComponent(filename)),
    token,
    'POST',
    bytes,
    contentType,
  );
function idOf(uri: string) {
  const prefix = 'mxc://' + serverName() + '/';
  assert(uri.startsWith(prefix));
  const id = uri.slice(prefix.length);
  assert(/^[A-Za-z0-9_-]{24}$/.test(id));
  return id;
}

test('M1/M2: authenticated and legacy downloads preserve bytes, verbatim type and stored headers', async () => {
  const user = await suite.registerTestUser('media-wire', 'pw');
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const up = await upload(user.access_token!, bytes, 'img/png', 'test.png');
  assertEquals(up.status, 200);
  const id = idOf((await up.json() as Json).content_uri as string);
  const dl = await request(
    '/_matrix/client/v1/media/download/' + serverName() + '/' + id,
    user.access_token!,
  );
  assertEquals(dl.status, 200);
  assertEquals(dl.headers.get('Content-Type'), 'img/png');
  assertEquals(dl.headers.get('Content-Length'), '32');
  assertEquals(
    dl.headers.get('Content-Disposition'),
    'attachment; filename="test.png"',
  );
  assertEquals(dl.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert(
    dl.headers.get('Content-Security-Policy')?.includes(
      "sandbox; default-src 'none'",
    ),
  );
  assertEquals(new Uint8Array(await dl.arrayBuffer()), bytes);
  const row = await getMedia(theApp().tenant, id);
  assertEquals(row?.localpart, 'media-wire');
  assertEquals(row?.state, 'uploaded');
  assertEquals(row?.size_bytes, 32);
  const standard = await upload(user.access_token!, bytes, 'image/png');
  const standardId = idOf(
    (await standard.json() as Json).content_uri as string,
  );
  const legacy = await request(
    '/_matrix/media/v3/download/' + serverName() + '/' + standardId,
  );
  assertEquals(legacy.status, 200);
  assertEquals(legacy.headers.get('Content-Type'), 'image/png');
  assertEquals(legacy.headers.get('Content-Disposition'), 'inline');
  assertEquals(new Uint8Array(await legacy.arrayBuffer()), bytes);
});

test('M1: authenticated download rejects missing and unknown tokens before lookup', async () => {
  for (const token of [undefined, 'unknown-token']) {
    const res = await request(
      '/_matrix/client/v1/media/download/hs1/garbage',
      token,
    );
    assertEquals(res.status, 401);
    assertEquals(
      (await res.json() as Json).errcode,
      token === undefined ? 'M_MISSING_TOKEN' : 'M_UNKNOWN_TOKEN',
    );
  }
});

test('M4: create, pending 504, owner-only PUT, overwrite 409, both downloads byte-equal', async () => {
  const user = await suite.registerTestUser('media-async', 'pw');
  const other = await suite.registerTestUser('media-other', 'pw');
  const cr = await request(
    '/_matrix/media/v1/create',
    user.access_token!,
    'POST',
  );
  assertEquals(cr.status, 200);
  const created = await cr.json() as Json;
  const id = idOf(String(created.content_uri));
  assertEquals(typeof created.unused_expires_at, 'number');
  const row = await getMedia(theApp().tenant, id);
  assertEquals(created.unused_expires_at, row!.created_ms + 86400000);
  const download = '/_matrix/media/v3/download/' + serverName() + '/' + id;
  const pending = await request(download);
  assertEquals(pending.status, 504);
  const missing = await pending.json() as Json;
  assertEquals(missing.errcode, 'M_NOT_YET_UPLOADED');
  assertEquals(typeof missing.error, 'string');
  const path = '/_matrix/media/v3/upload/' + serverName() + '/' + id;
  const forbidden = await request(
    path,
    other.access_token!,
    'PUT',
    new Uint8Array([1]),
    'image/png',
  );
  assertEquals(forbidden.status, 403);
  assertEquals((await forbidden.json() as Json).errcode, 'M_FORBIDDEN');
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const put = await request(
    path + '?filename=test.png',
    user.access_token!,
    'PUT',
    bytes,
    'image/png',
  );
  assertEquals(put.status, 200);
  await put.json();
  const repeated = await request(path, user.access_token!, 'PUT');
  assertEquals(repeated.status, 409);
  const conflict = await repeated.json() as Json;
  assertEquals(conflict.errcode, 'M_CANNOT_OVERWRITE_MEDIA');
  assertEquals(typeof conflict.error, 'string');
  for (
    const route of [
      '/_matrix/media/v3/download/',
      '/_matrix/client/v1/media/download/',
    ]
  ) {
    const res = await request(
      route + serverName() + '/' + id,
      user.access_token!,
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get('Content-Type'), 'image/png');
    assertEquals(new Uint8Array(await res.arrayBuffer()), bytes);
  }
});

test('over-limit upload is 413 M_TOO_LARGE and removes partial bytes', async (root) => {
  const user = await suite.registerTestUser('media-cap', 'pw');
  const res = await upload(
    user.access_token!,
    new Uint8Array(65),
    'application/octet-stream',
  );
  assertEquals(res.status, 413);
  assertEquals((await res.json() as Json).errcode, 'M_TOO_LARGE');
  const files = [];
  for await (const entry of Deno.readDir(root)) files.push(entry.name);
  assertEquals(files, []);
});

test('foreign, unknown and unsanitized MXC values are 404', async () => {
  const user = await suite.registerTestUser('media-unknown', 'pw');
  const up = await upload(
    user.access_token!,
    new Uint8Array([1, 2, 3]),
    'image/png',
  );
  const id = idOf(String((await up.json() as Json).content_uri));
  for (
    const path of [
      'evil.com/' + id,
      serverName() + '/doesnotexist00',
      serverName() + '/bad%2Fid',
    ]
  ) {
    const res = await request('/_matrix/media/v3/download/' + path);
    assertEquals(res.status, 404);
    assertEquals((await res.json() as Json).errcode, 'M_NOT_FOUND');
  }
});

test('M3: both config routes advertise a number and retain auth', async () => {
  const user = await suite.registerTestUser('media-config', 'pw');
  for (
    const path of [
      '/_matrix/media/v3/config',
      '/_matrix/client/v1/media/config',
    ]
  ) {
    const denied = await request(path);
    assertEquals(denied.status, 401);
    await denied.json();
    const res = await request(path, user.access_token!);
    assertEquals(res.status, 200);
    const body = await res.json() as Json;
    assertEquals(typeof body['m.upload.size'], 'number');
    assertEquals(body['m.upload.size'], 64);
  }
});

test('filename encoding and the agreed no-thumbnail behavior are retained', async () => {
  const user = await suite.registerTestUser('media-filename', 'pw');
  const up = await upload(
    user.access_token!,
    new Uint8Array([1]),
    'image/png',
    'caf\u00e9.png',
  );
  const id = idOf(String((await up.json() as Json).content_uri));
  const dl = await request(
    '/_matrix/client/v1/media/download/' + serverName() + '/' + id,
    user.access_token!,
  );
  assertEquals(
    dl.headers.get('Content-Disposition'),
    "inline; filename*=UTF-8''caf%C3%A9.png",
  );
  await dl.arrayBuffer();
  const thumbnail = '/_matrix/client/v1/media/thumbnail/' + serverName() + '/' +
    id + '?width=32&height=32';
  const anonymous = await request(thumbnail);
  assertEquals(anonymous.status, 401);
  await anonymous.json();
  const authed = await request(thumbnail, user.access_token!);
  assertEquals(authed.status, 404);
  await authed.json();
});
