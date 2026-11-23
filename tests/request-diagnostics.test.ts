import { assert, assertEquals } from '@std/assert';
import { request } from 'node:https';
import { operationHandler } from '#root/api/admin/handler.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { startLinkTransport } from '#engine/facade/transport.ts';
import { facadeTls } from './support/facade-tls.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { requestFailure } from '#engine/request-diagnostics.ts';
import { bounded } from './helpers/server-process.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { ServerLifetime } from '#root/api/server-lifetime.ts';

Deno.test('listener owner retains exceptions escaping the router before Deno renders 500', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  const lifetime = new ServerLifetime();
  const server = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    lifetime.wrap('cs', () => {
      throw new TypeError('escaped-router-marker');
    }),
  );
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.addr.port}/_matrix/client/v3/login?token=private-query`,
    );
    assertEquals(response.status, 500);
    await response.body?.cancel();
    const record = JSON.parse(
      lines.find((line) => line.startsWith('http failure: '))!.slice(
        'http failure: '.length,
      ),
    );
    assertEquals(record.path, '/_matrix/client/v3/login');
    assertEquals(record.error.message, 'escaped-router-marker');
    assert(record.error.stack.includes('request-diagnostics.test.ts'));
  } finally {
    await server.shutdown();
    console.error = original;
  }
});

Deno.test('createRoom preserves the original unexpected exception for the shared 500 owner', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const app = await pathfinder({ roots: ['tests/fixtures/http-contract/'] });
    const response = await app(
      new Request('http://test/create', { method: 'POST', body: '{}' }),
    );
    assertEquals(response.status, 500);
    await response.body?.cancel();
    const record = JSON.parse(
      lines.find((line) => line.startsWith('http failure: '))!.slice(
        'http failure: '.length,
      ),
    );
    assertEquals(record.error.name, 'Error');
    assert(record.error.stack.includes('app.ts'));
    assertEquals(record.path, '/create');
  } finally {
    console.error = original;
  }
});

Deno.test('nested peer failures keep their existing private-wire cause disclosure boundary', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    requestFailure(
      { method: 'GET', url: '/_matrix/client/v3/keys/query' },
      new Error('outer', {
        cause: new UpstreamError('protocol', {
          phase: 'json',
          reason: 'invalid JSON',
          cause: new SyntaxError('private-wire-sentinel'),
        }),
      }),
    );
    assert(lines[0].includes('UpstreamError'));
    assert(lines[0].includes('invalid JSON'));
    assert(!lines[0].includes('private-wire-sentinel'));
  } finally {
    console.error = original;
  }
});

Deno.test('typed Matrix 503 retains its original cause through the shared request observer', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const app = await pathfinder({ roots: ['tests/fixtures/http-contract/'] });
    const response = await app(
      new Request('http://test/typed?token=private-query'),
    );
    assertEquals(response.status, 503);
    assertEquals((await response.json()).errcode, 'M_UNAVAILABLE');
    const records = lines.filter((line) => line.startsWith('http failure: '));
    assertEquals(records.length, 1);
    const record = JSON.parse(records[0].slice('http failure: '.length));
    assertEquals(record.path, '/typed');
    assertEquals(record.error.cause.message, 'typed-child-marker');
    assert(record.error.cause.stack.includes('get.ts'));
  } finally {
    console.error = original;
  }
});

Deno.test('link post-upgrade response failure retains its exception and request identity', async () => {
  const tls = await facadeTls();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  const release = Promise.withResolvers<void>();
  const link = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: tls.facade,
    authorize: () => Promise.resolve(true),
    handle: () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            async pull(controller) {
              await release.promise;
              controller.error(new TypeError('upgraded-child-marker'));
            },
          }),
          { headers: { 'content-type': 'application/x-ndjson' } },
        ),
      ),
  });
  try {
    await bounded(
      new Promise<void>((resolve, reject) => {
        const req = request(
          link.url + '/_communico/link/v1/notices?token=private-query',
          {
            ...tls.home,
            agent: false,
            headers: {
              connection: 'Upgrade',
              upgrade: 'websocket',
              'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
              'sec-websocket-version': '13',
            },
          },
        );
        req.once('error', reject);
        req.once('response', () => reject(new Error('upgrade refused')));
        req.once('upgrade', (_response, socket) => {
          socket.once('close', () => resolve());
          socket.once('error', reject);
          release.resolve();
        });
        req.end();
      }),
    );
    const record = JSON.parse(
      lines.find((line) => line.startsWith('http failure: '))!.slice(
        'http failure: '.length,
      ),
    );
    assertEquals(record.path, '/_communico/link/v1/notices');
    assertEquals(record.method, 'GET');
    assertEquals(record.error.name, 'TypeError');
    assertEquals(record.error.message, 'upgraded-child-marker');
    assert(record.error.stack.includes('request-diagnostics.test.ts'));
  } finally {
    release.resolve();
    await link.close();
    console.error = original;
    await tls.close();
  }
});

Deno.test('Matrix shared 500 renderer retains unexpected cause and route', async () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const app = await pathfinder({ roots: ['tests/fixtures/http-contract/'] });
    const response = await app(
      new Request('http://test/?access_token=private-query'),
    );
    assertEquals(response.status, 500);
    assertEquals((await response.json()).errcode, 'M_UNKNOWN');
    const records = lines.filter((line) => line.startsWith('http failure: '));
    assertEquals(records.length, 1);
    const record = JSON.parse(records[0].slice('http failure: '.length));
    assertEquals(record.method, 'GET');
    assertEquals(record.path, '/');
    assertEquals(record.error.name, 'Error');
    assert(record.error.message.length > 0);
    assert(record.error.stack.includes('get.ts'));
    assert(!records[0].includes('private-query'));
  } finally {
    console.error = original;
  }
});

Deno.test('safe diagnostic retains nested Error causes, aggregates and cycles without arbitrary objects', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => lines.push(args.join(' '));
  try {
    const child = Object.assign(new TypeError('child-marker'), {
      body: 'private-body',
    });
    const root = new Error('outer-marker', {
      cause: new AggregateError(
        [child, { secret: 'private-secret' }],
        'children',
      ),
    });
    child.cause = root;
    requestFailure({
      method: 'POST',
      url: '/_matrix/client/v3/login?token=private-query',
    }, root);
    const record = JSON.parse(lines[0].slice('http failure: '.length));
    assertEquals(record.error.cause.errors[0].name, 'TypeError');
    assertEquals(record.error.cause.errors[0].message, 'child-marker');
    assert(
      record.error.cause.errors[0].stack.includes(
        'request-diagnostics.test.ts',
      ),
    );
    assert(!lines[0].includes('private-'));
    assert(lines[0].includes('Circular'));
  } finally {
    console.error = original;
  }
});

Deno.test('concurrent admin, link HTTP and pre-upgrade failures retain safe request-correlated exceptions', async () => {
  const tls = await facadeTls();
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(
      args.map((value) =>
        typeof value === 'string' ? value : Deno.inspect(value)
      ).join(' '),
    );
  };
  const release = Promise.withResolvers<void>();
  let entered = 0;
  async function fail(marker: string): Promise<never> {
    if (++entered === 6) release.resolve();
    await release.promise;
    // Non-public properties/causes must not turn exception logging into a
    // serialization of arbitrary request or private journal payloads.
    throw Object.assign(
      new Error(marker, {
        cause: { privatePayload: 'private-cause-sentinel' },
      }),
      {
        privatePayload: 'private-property-sentinel',
      },
    );
  }
  const admin = Deno.serve(
    { hostname: '127.0.0.1', port: 0, onListen() {} },
    operationHandler({
      '/v1/A/token/path-secret-sentinel': () => fail('admin-A'),
      '/v1/B/token/path-secret-sentinel': () => fail('admin-B'),
    }),
  );
  const link = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: tls.facade,
    authorize: () => Promise.resolve(true),
    handle: (req) =>
      req.headers.has('x-known')
        ? Promise.reject(
          new LinkError('LINK_BAD_RECORD', 'ordinary refusal', 400),
        )
        : fail(req.headers.get('x-case')!),
  });
  async function linkRequest(marker: string, upgrade: boolean, known = false) {
    const path = upgrade
      ? '/_communico/link/v1/notices'
      : '/_communico/link/v1/' + marker + '/token/path-secret-sentinel';
    return await new Promise<number>((resolve, reject) => {
      const req = request(
        link.url + path + '?access_token=query-secret-sentinel',
        {
          ...tls.home,
          method: upgrade ? 'GET' : 'POST',
          agent: false,
          headers: {
            'x-case': marker,
            authorization: 'Bearer header-secret-sentinel',
            ...(known ? { 'x-known': 'yes' } : {}),
            ...(upgrade ? { connection: 'Upgrade', upgrade: 'websocket' } : {}),
          },
        },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode!));
        },
      );
      req.once('error', reject);
      req.end(upgrade ? undefined : '{"password":"body-secret-sentinel"}');
    });
  }
  try {
    const jobs = ['A', 'B'].flatMap((id) => [
      (async () => {
        const response = await fetch(
          `http://127.0.0.1:${admin.addr.port}/v1/${id}/token/path-secret-sentinel?token=query-secret-sentinel`,
          {
            method: 'POST',
            headers: { authorization: 'Bearer header-secret-sentinel' },
            body: '{"password":"body-secret-sentinel"}',
          },
        );
        await response.body?.cancel();
        return response.status;
      })(),
      linkRequest('http-' + id, false),
      linkRequest('upgrade-' + id, true),
    ]);
    assertEquals(await Promise.all(jobs), [500, 500, 500, 500, 500, 500]);
    const diagnostics = lines.filter((line) =>
      line.startsWith('http failure: ')
    ).map((line) => JSON.parse(line.slice('http failure: '.length)));
    assertEquals(
      diagnostics.length,
      6,
      'each returned 500 needs its own safe exception record',
    );
    for (const id of ['A', 'B']) {
      for (
        const [marker, method, path] of [
          ['admin-' + id, 'POST', `/v1/${id}/token/[REDACTED]`],
          [
            'http-' + id,
            'POST',
            `/_communico/link/v1/http-${id}/token/[REDACTED]`,
          ],
          ['upgrade-' + id, 'GET', '/_communico/link/v1/notices'],
        ]
      ) {
        const matches = diagnostics.filter((entry) =>
          entry.error.message === marker
        );
        assertEquals(matches.length, 1);
        assertEquals(matches[0].method, method);
        assertEquals(matches[0].path, path);
        assertEquals(matches[0].error.name, 'Error');
        assert(matches[0].error.stack.includes('request-diagnostics.test.ts'));
      }
    }
    assert(
      !lines.join('\n').includes('-sentinel'),
      'credentials and private payloads must not be logged',
    );
    assertEquals(await linkRequest('ordinary', false, true), 400);
    assertEquals(await linkRequest('ordinary-upgrade', true, true), 400);
    assertEquals(
      lines.length,
      6,
      'ordinary refusals do not add internal-failure diagnostics',
    );
  } finally {
    release.resolve();
    await admin.shutdown();
    await link.close();
    console.error = original;
    await tls.close();
  }
});
