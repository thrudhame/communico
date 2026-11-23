import { assert, assertEquals, assertMatch } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { closeApp, openApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { ServerLifetime } from '#root/api/server-lifetime.ts';
import { fedCaller, remoteServer } from './http-federation.ts';
import { bounded } from './helpers/server-process.ts';

Deno.test('shutdown: expired drain cancels a returned streaming response before transport settlement', async () => {
  const lifetime = new ServerLifetime();
  const cancelled = Promise.withResolvers<void>();
  const cancelDone = Promise.withResolvers<void>();
  const server = Deno.serve(
    {
      hostname: '127.0.0.1',
      port: 0,
      onListen() {},
      signal: lifetime.controller.signal,
    },
    lifetime.wrap('cs', () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(65536));
          },
          async cancel() {
            cancelled.resolve();
            await cancelDone.promise;
          },
        }),
      )),
  );
  const connection = await Deno.connect({
    hostname: '127.0.0.1',
    port: server.addr.port,
  });
  try {
    await connection.write(new TextEncoder().encode(
      'GET /download HTTP/1.1\r\nHost: localhost\r\n\r\n',
    ));
    const first = new Uint8Array(1024);
    assert((await bounded(connection.read(first)))! > 0);
    assert(new TextDecoder().decode(first).startsWith('HTTP/1.1 200'));
    // The handler has returned, but this client stops reading its unbounded
    // response. Operation cancellation must also own the already-returned body.
    assertEquals(lifetime.count, 1);
    assertEquals(await lifetime.drain(0), { cs: 1 });
    const closing = lifetime.close();
    await bounded(cancelled.promise, 1000);
    // Transport abort cannot retire a still-running source cancellation child.
    assertEquals(lifetime.count, 1);
    cancelDone.resolve();
    await bounded(closing, 1000);
    assertEquals(lifetime.count, 0);
  } finally {
    cancelDone.resolve();
    connection.close();
    lifetime.abort();
    await server.shutdown();
  }
});

for (
  const finish of ['within grace', 'cancelled', 'close while held'] as const
) {
  Deno.test(`shutdown: real federation send ${finish} retains its callback and gives a retryable wire outcome`, async () => {
    setConfigForTests({ federation: { enabled: true, mode: 'open' } });
    const dir = await Deno.makeTempDir({ prefix: 'shutdown-' });
    const app = await openApp({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 4120000,
      maxopenfiles: 8,
      idleseconds: 300,
    });
    const lifetime = new ServerLifetime();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const effects: Record<string, unknown>[] = [];
    app.federationEdus.register('test.shutdown', (_origin, content) => {
      effects.push(content);
      return Promise.resolve();
    }, true);
    const query = app.server.query.bind(app.server);
    let held = false;
    app.server.query = async (sql, params) => {
      if (!held && sql.includes('SELECT response FROM federation_txns')) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return await query(sql, params);
    };
    const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
    const server = Deno.serve(
      {
        hostname: '127.0.0.1',
        port: 0,
        onListen() {},
        signal: lifetime.controller.signal,
      },
      lifetime.wrap('federation', (request, info) => {
        request.signal.addEventListener('abort', () => cancelled.resolve(), {
          once: true,
        });
        return matrix(request, info);
      }),
    );
    const base = `http://127.0.0.1:${server.addr.port}`;
    const peer = await remoteServer('shutdown-peer.test');
    const send = fedCaller(
      (request) =>
        fetch(new Request(base + new URL(request.url).pathname, request)),
      peer,
    );
    const path = '/_matrix/federation/v1/send/shutdown-owned';
    const body = {
      origin: peer.name,
      origin_server_ts: 1,
      pdus: [],
      edus: [{ edu_type: 'test.shutdown', content: { effect: 'once' } }],
    };
    const run = send('PUT', path, body);
    // Observe a negative wire result without an unhandled rejection in the red run.
    const result = Promise.allSettled([run]);
    let drain: Promise<Record<string, number>> | undefined;
    let closing: Promise<void> | undefined;
    try {
      await bounded(entered.promise);
      drain = lifetime.drain(finish === 'within grace' ? 60 : 0);
      const refused = await fetch(base + '/_matrix/client/versions');
      assertEquals(refused.status, 503);
      await refused.body?.cancel();
      if (finish !== 'within grace') {
        await bounded(cancelled.promise);
        assertEquals(
          lifetime.count,
          1,
          'cancellation cannot release a live store capability',
        );
      }
      // Synapse stops listeners then loses connections at forced shutdown.
      // Once grace expires, 503 delivery may race the transport's EOF/reset;
      // transaction effects and retryability, not a second flush wait, govern.
      if (finish === 'close while held') closing = lifetime.close();
      release.resolve();
      const [outcome] = await bounded(result);
      if (finish === 'close while held' && outcome.status === 'rejected') {
        assert(outcome.reason instanceof TypeError);
        assert(outcome.reason.cause instanceof Error);
        assertMatch(
          outcome.reason.cause.message,
          /connection (closed|reset)|EOF|broken pipe/i,
        );
      } else {
        assertEquals(outcome.status, 'fulfilled');
        assert(outcome.status === 'fulfilled');
        assertEquals(
          outcome.value.status,
          finish === 'within grace' ? 200 : 503,
        );
        if (finish !== 'within grace') {
          assertEquals(outcome.value.body.errcode, 'M_UNKNOWN');
        }
      }
      if (closing) await bounded(closing);
      await bounded(drain);
      await bounded(lifetime.settled());
      const cached = await query(
        'SELECT response FROM federation_txns WHERE txn_id=?',
        ['shutdown-owned'],
      );
      assertEquals(cached.length, finish === 'within grace' ? 1 : 0);
      assertEquals(
        effects,
        finish === 'within grace' ? [{ effect: 'once' }] : [],
      );
      // A stopped server must not turn an interrupted send into cached success.
      // The same transaction is retryable at the actual engine boundary.
      if (finish !== 'within grace') {
        const { receiveTransaction } = await import(
          '#engine/federation/transactions.ts'
        );
        const { transactionDeps } = await import(
          '#engine/federation/context.ts'
        );
        for (let retry = 0; retry < 2; retry++) {
          assertEquals(
            (await receiveTransaction(
              peer.name,
              'shutdown-owned',
              body,
              transactionDeps(),
            )).status,
            200,
          );
          assertEquals(effects, [{ effect: 'once' }]);
        }
        assertEquals(
          (await query('SELECT response FROM federation_txns WHERE txn_id=?', [
            'shutdown-owned',
          ])).length,
          1,
        );
      }
    } finally {
      release.resolve();
      await result;
      if (drain) await drain;
      if (closing) await closing;
      await server.shutdown();
      app.server.query = query;
      await closeApp();
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({ federation: { enabled: false } });
    }
  });
}
