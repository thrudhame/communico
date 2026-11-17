import { assert, assertEquals } from '@std/assert';
import { request } from 'node:https';
import { operationHandler } from '#root/api/admin/handler.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import { startLinkTransport } from '#engine/facade/transport.ts';
import { facadeTls } from './support/facade-tls.ts';

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
