import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { bounded } from './helpers/server-process.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('runtime inbox failures retain safe causes, stream identities and readiness without private records', async (t) => {
  const tls = await facadeTls();
  try {
    for (const initialized of [false, true]) {
      await t.step(`initialized=${initialized}`, async () => {
        setConfigForTests({
          server: { name: 'logical.test', role: 'facade' },
          facade: {
            phase: 'f1',
            nodeid: 'edge_a',
            pollseconds: 3600,
            linkcert: tls.dir + '/facade.crt',
            linkkey: tls.dir + '/facade.key',
            linkcacerts: [tls.dir + '/ca.crt'],
          },
        });
        const streams = [
          'auth:@outside:logical.test',
          'domain:@outside:logical.test',
          'room:!affected:logical.test',
          'extension:diagnostic',
        ];
        const lines: string[] = [];
        const reported = Promise.withResolvers<void>();
        const original = console.error;
        console.error = (...args: unknown[]) => {
          lines.push(args.map(String).join(' '));
          if (lines.length === streams.length) reported.resolve();
        };
        let runtime: Awaited<ReturnType<typeof openFacadeRuntime>> | undefined;
        try {
          runtime = await openFacadeRuntime({
            dir: tls.dir + '/store-' + initialized,
            library: './.native/libturso_ffi.so',
            checkpointlogbytes: 65536,
            maxopenfiles: 8,
            idleseconds: 300,
          }, async (journal, stream) => {
            const record = await journal.next('home', stream);
            assert(record);
            assertEquals(record.payload, {
              password: 'private-record-sentinel',
            });
            const error = stream.stream.startsWith('extension:')
              ? new TypeError('injected application failure')
              : new MatrixError(
                503,
                'M_UNAVAILABLE',
                'injected owner not ready',
                {
                  access_token: 'private-body-sentinel',
                },
              );
            throw Object.assign(error, {
              cause: { secret: 'private-cause-sentinel' },
              privatePayload: 'private-property-sentinel',
            });
          });
          if (initialized) await runtime.initialize();
          for (const stream of streams) {
            const record = await runtime.journal.append('edge_a', {
              source: 'home',
              incarnation: 'pair-diagnostic',
              stream,
              type: 'control',
              version: 1,
              operationId: stream,
              payload: { password: 'private-record-sentinel' },
            });
            await runtime.journal.receive('home', [record]);
          }
          await runtime.changed();
          await bounded(reported.promise, 5000);
          await runtime.close();
          const records = lines.filter((line) =>
            line.startsWith('inbox failure: ')
          ).map((line) => JSON.parse(line.slice('inbox failure: '.length)));
          assertEquals(
            records.length,
            streams.length,
            'each inbox failure needs its underlying cause',
          );
          for (const stream of streams) {
            const matches = records.filter((entry) =>
              entry.stream?.stream === stream
            );
            assertEquals(matches.length, 1);
            const entry = matches[0];
            assertEquals(entry.server, 'logical.test');
            assertEquals(entry.node, 'edge_a');
            assertEquals(entry.peer, 'home');
            assertEquals(entry.stream, {
              source: 'home',
              incarnation: 'pair-diagnostic',
              stream,
            });
            assertEquals(entry.after, 0);
            assertEquals(entry.readiness, {
              initialized,
              tenantAvailable: false,
              phase: 'f1',
            });
            if (stream.startsWith('room:')) {
              assertEquals(entry.error.name, 'LinkError');
              assertEquals(
                entry.error.message,
                initialized
                  ? 'not a room replica'
                  : 'facade node has not been initialized',
              );
              assertEquals(
                entry.error.code,
                initialized ? 'LINK_CAPABILITY_MISMATCH' : 'LINK_UNPAIRED',
              );
              assertEquals(entry.error.status, initialized ? 409 : 503);
            } else if (stream.startsWith('extension:')) {
              assertEquals(entry.error.name, 'TypeError');
              assertEquals(entry.error.message, 'injected application failure');
            } else {
              assertEquals(entry.error.name, 'HttpError');
              assertEquals(
                entry.error.message,
                'M_UNAVAILABLE: injected owner not ready',
              );
              assertEquals(entry.error.status, 503);
              assertEquals(entry.error.errcode, 'M_UNAVAILABLE');
            }
            assert(typeof entry.error.stack === 'string');
          }
          assert(
            !lines.join('\n').includes('-sentinel'),
            'private exception properties, bodies, causes and journal payloads must not be logged',
          );
        } finally {
          await runtime?.close();
          console.error = original;
        }
      });
    }
  } finally {
    await tls.close();
    setConfigForTests({});
  }
});
