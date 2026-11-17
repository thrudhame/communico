import { assert, assertEquals } from '@std/assert';
import { pathfinder } from '@pathfinder/pathfinder';
import { closeApp, openApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { ServerLifetime } from '#root/api/server-lifetime.ts';
import { fedCaller, remoteServer } from './http-federation.ts';
import { bounded } from './helpers/server-process.ts';

for (const finish of ['within grace', 'cancelled'] as const) {
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
    const body = { origin: peer.name, origin_server_ts: 1, pdus: [], edus: [] };
    const run = send('PUT', path, body);
    // Observe a negative wire result without an unhandled rejection in the red run.
    const result = Promise.allSettled([run]);
    let drain: Promise<Record<string, number>> | undefined;
    try {
      await bounded(entered.promise);
      drain = lifetime.drain(finish === 'cancelled' ? 0 : 60);
      const refused = await fetch(base + '/_matrix/client/versions');
      assertEquals(refused.status, 503);
      await refused.body?.cancel();
      if (finish === 'cancelled') {
        await bounded(cancelled.promise);
        assertEquals(
          lifetime.count,
          1,
          'cancellation cannot release a live store capability',
        );
      }
      release.resolve();
      const [outcome] = await bounded(result);
      assertEquals(outcome.status, 'fulfilled');
      assert(outcome.status === 'fulfilled');
      assertEquals(outcome.value.status, finish === 'cancelled' ? 503 : 200);
      if (finish === 'cancelled') {
        assertEquals(outcome.value.body.errcode, 'M_UNKNOWN');
      }
      await bounded(drain);
      await bounded(lifetime.settled());
      const cached = await query(
        'SELECT response FROM federation_txns WHERE txn_id=?',
        ['shutdown-owned'],
      );
      assertEquals(cached.length, finish === 'cancelled' ? 0 : 1);
      // A stopped server must not turn an interrupted send into cached success.
      // The same transaction is retryable at the actual engine boundary.
      if (finish === 'cancelled') {
        const { receiveTransaction } = await import(
          '#engine/federation/transactions.ts'
        );
        const { transactionDeps } = await import(
          '#engine/federation/context.ts'
        );
        assertEquals(
          (await receiveTransaction(
            peer.name,
            'shutdown-owned',
            body,
            transactionDeps(),
          )).status,
          200,
        );
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
      await server.shutdown();
      app.server.query = query;
      await closeApp();
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({ federation: { enabled: false } });
    }
  });
}
