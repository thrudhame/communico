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

test('reserved upload publishes exactly once under concurrent PUTs', async (root) => {
  const user = await suite.registerTestUser('media-concurrent', 'pw');
  const created = await request(
    '/_matrix/media/v1/create',
    user.access_token!,
    'POST',
  );
  const id = idOf(String((await created.json() as Json).content_uri));
  const path = '/_matrix/media/v3/upload/' + serverName() + '/' + id;
  const bodies = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])];
  // Hold the first publisher after admission but before writing. Without the
  // shared owner, the second PUT passes its pending check and publishes first.
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => entered = resolve);
  const held = new Promise<void>((resolve) => release = resolve);
  const open = Deno.open;
  const create = Deno.create;
  let first = true;
  async function hold(file: Deno.FsFile, name: string | URL) {
    if (
      first && typeof name === 'string' && name.startsWith(root + '/') &&
      name.endsWith('.part')
    ) {
      first = false;
      entered();
      await held;
    }
    return file;
  }
  Deno.open = async (name, options) => hold(await open(name, options), name);
  Deno.create = async (name) => hold(await create(name), name);
  let responses: Response[];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const one = request(
      path,
      user.access_token!,
      'PUT',
      bodies[0],
      'application/octet-stream',
    );
    await started;
    const two = request(
      path,
      user.access_token!,
      'PUT',
      bodies[1],
      'application/octet-stream',
    );
    await Promise.race([
      two,
      new Promise<void>((resolve) => timer = setTimeout(resolve, 100)),
    ]);
    release();
    responses = await Promise.all([one, two]);
  } finally {
    release();
    clearTimeout(timer);
    Deno.open = open;
    Deno.create = create;
  }
  const statuses = responses.map((response) => response.status);
  const results = await Promise.all(
    responses.map((response) => response.json()),
  );
  assertEquals([...statuses].sort(), [200, 409]);
  assertEquals(
    results[statuses.indexOf(409)].errcode,
    'M_CANNOT_OVERWRITE_MEDIA',
  );
  const download = await request(
    '/_matrix/media/v3/download/' + serverName() + '/' + id,
  );
  const winner = bodies[statuses.indexOf(200)];
  assertEquals(new Uint8Array(await download.arrayBuffer()), winner);
  assertEquals(
    (await getMedia(theApp().tenant, id))?.size_bytes,
    winner.length,
  );
});

// Observe real file handles, including failures, rather than treating rename
// or a successful HTTP response as evidence that the bytes reached disk.
async function observePublication<T>(
  root: string,
  fn: (events: string[]) => Promise<T>,
  fail?: 'file-sync' | 'directory-sync',
): Promise<T> {
  const events: string[] = [];
  const open = Deno.open;
  const create = Deno.create;
  const rename = Deno.rename;
  function observe(file: Deno.FsFile, path: string | URL): Deno.FsFile {
    if (
      typeof path !== 'string' ||
      !(path === root || path.startsWith(root + '/'))
    ) return file;
    const kind = path === root ? 'directory' : 'file';
    const sync = file.sync.bind(file);
    const close = file.close.bind(file);
    file.sync = async () => {
      events.push(kind + '-sync');
      if (fail === kind + '-sync') {
        throw new Error('injected media fsync failure');
      }
      await sync();
    };
    file.close = () => {
      events.push(kind + '-close');
      close();
    };
    return file;
  }
  Deno.open = async (path, options) => observe(await open(path, options), path);
  Deno.create = async (path) => observe(await create(path), path);
  Deno.rename = async (source, destination) => {
    if (typeof destination === 'string' && destination.startsWith(root + '/')) {
      events.push('rename');
    }
    await rename(source, destination);
  };
  try {
    return await fn(events);
  } finally {
    Deno.open = open;
    Deno.create = create;
    Deno.rename = rename;
  }
}

test('local upload fsyncs bytes before close and rename, then parent before metadata acknowledgment', async (root) => {
  const user = await suite.registerTestUser('media-durable', 'pw');
  await observePublication(root, async (events) => {
    const response = await upload(
      user.access_token!,
      new Uint8Array([1, 2]),
      'text/plain',
    );
    assertEquals(response.status, 200);
    const id = idOf(String((await response.json() as Json).content_uri));
    assertEquals(events, [
      'file-sync',
      'file-close',
      'rename',
      'directory-sync',
      'directory-close',
    ]);
    assertEquals((await getMedia(theApp().tenant, id))?.state, 'uploaded');
    assertEquals((await Deno.stat(root + '/' + id)).mode! & 0o777, 0o600);
  });
});

for (const failure of ['file-sync', 'directory-sync'] as const) {
  test(
    'failed ' + failure + ' leaves reserved metadata pending and permits retry',
    async (root) => {
      const user = await suite.registerTestUser('media-fsync-' + failure, 'pw');
      const created = await request(
        '/_matrix/media/v1/create',
        user.access_token!,
        'POST',
      );
      const id = idOf(String((await created.json() as Json).content_uri));
      const path = '/_matrix/media/v3/upload/' + serverName() + '/' + id;
      await observePublication(root, async () => {
        const response = await request(
          path,
          user.access_token!,
          'PUT',
          new Uint8Array([1]),
          'text/plain',
        );
        await response.arrayBuffer();
        assertEquals(response.status, 500);
        assertEquals((await getMedia(theApp().tenant, id))?.state, 'pending');
      }, failure);
      const retried = await request(
        path,
        user.access_token!,
        'PUT',
        new Uint8Array([2, 3]),
        'text/plain',
      );
      assertEquals(retried.status, 200);
      await retried.arrayBuffer();
      const download = await request(
        '/_matrix/media/v3/download/' + serverName() + '/' + id,
      );
      assertEquals(
        new Uint8Array(await download.arrayBuffer()),
        new Uint8Array([2, 3]),
      );
    },
  );
}

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

test('filename encoding and malformed-image thumbnail refusal', async () => {
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
  assertEquals(authed.status, 400);
  await authed.json();
});
