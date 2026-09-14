// tests/media.test.ts — the media wire (plan §3.8): upload→download
// byte-equality, verbatim content type, async create/put/409, pending→504,
// no-token v1 download → 401, over-limit → 413, foreign server → 404, and
// the M3 config number. In-process pathfinder against live doltgres; the
// bytes land in a per-run temp MEDIA_ROOT (set before the first
// mediaRoot() call — it memoizes) with a tiny limit so the 413 is cheap.
import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { serverName } from '#engine/config.ts';
import { registerTestUser } from './util.ts';

const MEDIA_DIR = await Deno.makeTempDir();
Deno.env.set('MEDIA_ROOT', MEDIA_DIR);
Deno.env.set('MEDIA_MAX_BYTES', '64');

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const SN = serverName();

type Json = Record<string, unknown>;

function mediaIdOf(contentUri: string): string {
  const prefix = `mxc://${SN}/`;
  assert(contentUri.startsWith(prefix), `not a local mxc URI: ${contentUri}`);
  return contentUri.slice(prefix.length);
}

/** registerTestUser always returns a token (no inhibit) — narrow once. */
function tokenOf(u: { access_token?: string }): string {
  assert(typeof u.access_token === 'string', 'register returned no access_token');
  return u.access_token;
}

async function upload(
  token: string,
  bytes: Uint8Array,
  contentType: string,
  filename?: string,
): Promise<Response> {
  const qs = filename === undefined ? '' : `?filename=${encodeURIComponent(filename)}`;
  return await matrix(new Request(`http://x/_matrix/media/v3/upload${qs}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': contentType },
    body: bytes as BodyInit,
  }));
}

Deno.test('M1/M2: upload → authed + legacy download — byte-equality, verbatim Content-Type', async () => {
  const u = await registerTestUser('m1media', 'pw-m1media');
  const tok = tokenOf(u);
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  // Non-standard type — Complement M1 asserts the verbatim echo.
  const up = await upload(tok, bytes, 'img/png', 'test.png');
  assertEquals(up.status, 200);
  const id = mediaIdOf((await up.json() as Json).content_uri as string);
  const dl = await matrix(new Request(`http://x/_matrix/client/v1/media/download/${SN}/${id}`, {
    headers: { Authorization: `Bearer ${tok}` },
  }));
  assertEquals(dl.status, 200);
  assertEquals(dl.headers.get('Content-Type'), 'img/png');
  assertEquals(new Uint8Array(await dl.arrayBuffer()), bytes);
  // Legacy UNAUTHENTICATED download (M2 row) with a standard type.
  const up2 = await upload(tok, bytes, 'image/png');
  assertEquals(up2.status, 200);
  const id2 = mediaIdOf((await up2.json() as Json).content_uri as string);
  const dl2 = await matrix(new Request(`http://x/_matrix/media/v3/download/${SN}/${id2}`));
  assertEquals(dl2.status, 200);
  assertEquals(dl2.headers.get('Content-Type'), 'image/png');
  assertEquals(new Uint8Array(await dl2.arrayBuffer()), bytes);
});

Deno.test('M1: no-token authed download → 401 before any lookup', async () => {
  const res = await matrix(new Request('http://x/_matrix/client/v1/media/download/hs1/garbage'));
  assertEquals(res.status, 401);
  assertEquals((await res.json() as Json).errcode, 'M_MISSING_TOKEN');
});

Deno.test('M4: async create → pending 504 → PUT 200 → second PUT 409 → downloads byte-equal', async () => {
  const u = await registerTestUser('m4media', 'pw-m4media');
  const tok = tokenOf(u);
  const cr = await matrix(new Request('http://x/_matrix/media/v1/create', {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}` },
  }));
  assertEquals(cr.status, 200);
  const crBody = await cr.json() as { content_uri: string; unused_expires_at: number };
  const id = mediaIdOf(crBody.content_uri);
  assertEquals(typeof crBody.unused_expires_at, 'number');
  // Created-not-uploaded → 504 M_NOT_YET_UPLOADED with an error string.
  const pending = await matrix(new Request(`http://x/_matrix/media/v3/download/${SN}/${id}`));
  assertEquals(pending.status, 504);
  const pb = await pending.json() as Json;
  assertEquals(pb.errcode, 'M_NOT_YET_UPLOADED');
  assertEquals(typeof pb.error, 'string');
  // PUT the bytes to the created id.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const put = await matrix(new Request(
    `http://x/_matrix/media/v3/upload/${SN}/${id}?filename=test.png`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'image/png' },
      body: bytes as BodyInit,
    },
  ));
  assertEquals(put.status, 200);
  // Second PUT (no body) → 409 M_CANNOT_OVERWRITE_MEDIA + error.
  const put2 = await matrix(new Request(`http://x/_matrix/media/v3/upload/${SN}/${id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok}` },
  }));
  assertEquals(put2.status, 409);
  const p2b = await put2.json() as Json;
  assertEquals(p2b.errcode, 'M_CANNOT_OVERWRITE_MEDIA');
  assertEquals(typeof p2b.error, 'string');
  // Both download endpoints → bytes + exact type.
  for (const url of [
    `http://x/_matrix/media/v3/download/${SN}/${id}`,
    `http://x/_matrix/client/v1/media/download/${SN}/${id}`,
  ]) {
    const res = await matrix(new Request(url, {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    assertEquals(res.status, 200, url);
    assertEquals(res.headers.get('Content-Type'), 'image/png', url);
    assertEquals(new Uint8Array(await res.arrayBuffer()), bytes, url);
  }
});

Deno.test('over-limit upload → 413 M_TOO_LARGE', async () => {
  const u = await registerTestUser('m413', 'pw-m413');
  const res = await upload(tokenOf(u), new Uint8Array(65), 'application/octet-stream');
  assertEquals(res.status, 413);
  assertEquals((await res.json() as Json).errcode, 'M_TOO_LARGE');
});

Deno.test('foreign server / unknown id → 404 M_NOT_FOUND', async () => {
  const u = await registerTestUser('m404', 'pw-m404');
  const up = await upload(tokenOf(u), crypto.getRandomValues(new Uint8Array(8)), 'image/png');
  assertEquals(up.status, 200);
  const id = mediaIdOf((await up.json() as Json).content_uri as string);
  const foreign = await matrix(new Request(`http://x/_matrix/media/v3/download/evil.com/${id}`));
  assertEquals(foreign.status, 404);
  assertEquals((await foreign.json() as Json).errcode, 'M_NOT_FOUND');
  const unknown = await matrix(new Request(`http://x/_matrix/media/v3/download/${SN}/doesnotexist00`));
  assertEquals(unknown.status, 404);
  assertEquals((await unknown.json() as Json).errcode, 'M_NOT_FOUND');
});

Deno.test('M3: config — m.upload.size is a JSON number (both endpoints)', async () => {
  const u = await registerTestUser('m3cfg', 'pw-m3cfg');
  const tok = tokenOf(u);
  for (const path of ['/_matrix/media/v3/config', '/_matrix/client/v1/media/config']) {
    const res = await matrix(new Request(`http://x${path}`, {
      headers: { Authorization: `Bearer ${tok}` },
    }));
    assertEquals(res.status, 200, path);
    const body = await res.json() as Json;
    assertEquals(typeof body['m.upload.size'], 'number', path);
    assertEquals(body['m.upload.size'], 64, path);
  }
});
