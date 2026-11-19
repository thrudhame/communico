import { assertEquals, assertRejects } from '@std/assert';
import {
  beforeFacadePublication,
  facadeFailure,
  FacadeHealthConnections,
  FacadeObservations,
  facadeProcess,
  observeJournalApplication,
  observeJournalCompletion,
  publicationCommand,
} from './helpers/facade-process.ts';
import { LinkError, recordHash } from '#engine/facade/protocol.ts';
import { facadeTls } from './support/facade-tls.ts';
import { Journal } from '#engine/facade/journal.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { pause } from './helpers/server-process.ts';

function record(stream = 'control', sequence = 1) {
  const record = {
    source: 'home',
    incarnation: 'pairing',
    stream,
    sequence,
    previous: '',
    type: 'control',
    version: 1,
    operationId: 'record-' + sequence,
    payload: { revision: sequence },
  };
  return { ...record, hash: recordHash(record) };
}

Deno.test('facade observations retain exact completions across waiter enrollment', async () => {
  const observations = new FacadeObservations();
  const expected = record();
  observations.accept({ kind: 'applied', peer: 'home', record: expected });
  assertEquals(
    await observations.applied(
      'control',
      (record) => record.hash === expected.hash,
    ),
    expected,
  );
});

Deno.test('journal transaction refusals preserve stream isolation and dependency classification', async (t) => {
  for (const method of ['apply', 'complete'] as const) {
    for (const code of ['LINK_UNAVAILABLE', 'LINK_BAD_RECORD'] as const) {
      await t.step(method + ' ' + code, async () => {
        const observations = new FacadeObservations();
        const expected = record('directory');
        const independent = record('auth:@alice:logical.test');
        const scope = { peer: 'home', ...expected, after: 0 };
        const own = observations.fact(scope, () => true).catch((error) =>
          error
        );
        const other = observations.applied(independent.stream).catch((error) =>
          error
        );
        const refusal = new LinkError(code, 'transaction refused');
        const events: unknown[] = [];
        const report = (...args: Parameters<typeof facadeFailure>) => {
          const event = facadeFailure(...args);
          events.push(event);
          observations.accept(event);
        };
        const journal = {
          heads: () => Promise.resolve({ applied: { sequence: 0 } }),
        } as unknown as Journal;
        await assertRejects(
          () =>
            method === 'apply'
              ? observeJournalApplication(
                () => Promise.reject(refusal),
                () => {},
                report,
              ).call(journal, 'home', expected, () => Promise.resolve(null))
              : observeJournalCompletion(
                () => Promise.reject(refusal),
                () => {},
                report,
              ).call(journal, 'home', expected, {
                sequence: 1,
                hash: expected.hash,
              }, null),
          LinkError,
          'transaction refused',
        );
        observations.accept({
          kind: 'applied',
          peer: 'home',
          record: independent,
        });
        observations.accept({
          kind: 'applied',
          peer: 'home',
          record: expected,
        });
        assertEquals(await other, independent);
        const observed = await own;
        if (code === 'LINK_UNAVAILABLE') assertEquals(observed, expected);
        else assertEquals(observed instanceof Error, true);
        assertEquals(events, [
          facadeFailure('journal ' + method + ' directory', refusal, {
            peer: 'home',
            source: expected.source,
            incarnation: expected.incarnation,
            stream: expected.stream,
            after: 0,
          }),
        ]);
      });
    }
  }
});

Deno.test('facade observations do not substitute another stream, fact or old completion', async () => {
  const observations = new FacadeObservations();
  const old = record(), expected = record('control', 2);
  observations.accept({ kind: 'applied', peer: 'home', record: old });
  const mark = observations.mark();
  let completed = false;
  const pending = observations.applied(
    'control',
    (record) => record.hash === expected.hash,
    mark,
  ).then((record) => {
    completed = true;
    return record;
  });
  observations.accept({
    kind: 'applied',
    peer: 'home',
    record: record('directory', 2),
  });
  observations.accept({ kind: 'applied', peer: 'home', record: old });
  await pause(0);
  assertEquals(completed, false);
  observations.accept({ kind: 'applied', peer: 'home', record: expected });
  assertEquals(await pending, expected);
});

Deno.test('facade observations reject pending and future observations on operation failure', async () => {
  const observations = new FacadeObservations();
  const pending = assertRejects(
    () => observations.applied('control'),
    Error,
    'journal apply',
  );
  observations.accept({
    kind: 'failure',
    operation: 'journal apply',
    error: 'StoreError',
  });
  await pending;
  await assertRejects(
    () => observations.applied('control'),
    Error,
    'journal apply',
  );
});

Deno.test('facade observations reject pending observations when their child exits', async () => {
  const observations = new FacadeObservations();
  const pending = assertRejects(
    () => observations.applied('control'),
    Error,
    'child exited',
  );
  observations.close(new Error('child exited'));
  await pending;
});

Deno.test('facade dependency waits remain observable without becoming terminal rejections', async () => {
  const observations = new FacadeObservations();
  const expected = record('directory');
  const pending = observations.applied('directory');
  observations.accept({
    kind: 'blocked',
    operation: 'inbox directory',
    error: 'LINK_UNAVAILABLE',
  });
  await observations.wait((event) => event.kind === 'blocked');
  observations.accept({ kind: 'applied', peer: 'home', record: expected });
  assertEquals(await pending, expected);
});

Deno.test('inbox rejections fail their own tail without poisoning independent stream callers', async () => {
  const observations = new FacadeObservations();
  const expected = record('auth:@alice:logical.test');
  const independent = observations.applied(expected.stream).catch((error) =>
    error
  );
  const rejected = assertRejects(
    () => observations.applied('directory'),
    Error,
    'LINK_BAD_RECORD',
  );
  const refusal = {
    kind: 'failure' as const,
    operation: 'inbox directory',
    error: 'LINK_BAD_RECORD',
    scope: {
      peer: 'home',
      source: 'home',
      incarnation: 'pairing',
      stream: 'directory',
    },
  };
  observations.accept(refusal);
  await rejected;
  await assertRejects(
    () => observations.applied('directory'),
    Error,
    'LINK_BAD_RECORD',
  );
  observations.accept({ kind: 'applied', peer: 'home', record: expected });
  assertEquals(await independent, expected);
});

Deno.test('a recovered inbox prefix does not poison a later finite tail or clear a newer refusal', async () => {
  const observations = new FacadeObservations();
  const first = record('directory'), next = record('directory', 2);
  const scope = {
    peer: 'home',
    source: first.source,
    incarnation: first.incarnation,
    stream: first.stream,
    after: 0,
  };
  observations.accept({
    kind: 'failure',
    operation: 'inbox directory',
    error: 'LINK_BAD_RECORD',
    scope,
  });
  observations.accept({ kind: 'applied', peer: 'home', record: first });
  const pending = observations.fact(
    scope,
    (record) => record.hash === next.hash,
  ).catch((error) => error);
  observations.accept({ kind: 'applied', peer: 'home', record: next });
  assertEquals(await pending, next);
  const newer = { ...scope, after: 2 };
  observations.accept({
    kind: 'failure',
    operation: 'inbox directory',
    error: 'LINK_DIVERGED',
    scope: newer,
  });
  observations.accept({ kind: 'applied', peer: 'home', record: first });
  await assertRejects(
    () => observations.fact(scope, (record) => record.sequence === 3),
    Error,
    'LINK_DIVERGED',
  );
});

Deno.test('facade observations bind fact completion to the peer and source incarnation', async () => {
  const observations = new FacadeObservations();
  const expected = record();
  let completed = false;
  const pending = observations.fact({
    peer: 'home',
    source: expected.source,
    incarnation: expected.incarnation,
    stream: expected.stream,
  }, (record) => record.hash === expected.hash).then(() => completed = true);
  observations.accept({ kind: 'applied', peer: 'other', record: expected });
  observations.accept({
    kind: 'applied',
    peer: 'home',
    record: { ...expected, incarnation: 'old' },
  });
  await pause(0);
  assertEquals(completed, false);
  observations.accept({ kind: 'applied', peer: 'home', record: expected });
  await pending;
  assertEquals(completed, true);
});

Deno.test('facade observation child reports real listener binding and services its private control pipe', async () => {
  const tls = await facadeTls();
  const probe = Deno.listen({ hostname: '127.0.0.1', port: 0 });
  const port = probe.addr.port;
  probe.close();
  const config = tls.dir + '/observation.toml';
  await Deno.writeTextFile(
    config,
    `[server]\nname="observation.test"\nport=${port}\n[store]\ndir="${tls.dir}/store"\n[media]\nroot="${tls.dir}/media"\n[admin]\nsocket="${tls.dir}/admin.sock"\n[federation]\nenabled=false\n`,
  );
  const child = await facadeProcess(config, 'federation: disabled', [
    'contract',
  ]);
  try {
    await child.listening(port);
    await child.fence();
    const response = await fetch(
      `http://127.0.0.1:${port}/_matrix/client/v3/login`,
    );
    assertEquals(response.status, 200);
    await response.body?.cancel();
    const publication = await child.holdPublication('contract');
    await publication.release();
    await child.stop();
  } finally {
    await child.dispose();
    await tls.close();
  }
});

Deno.test('facade publication gate remains pending until its explicit release', async () => {
  const observations = new FacadeObservations();
  const emit = observations.accept.bind(observations);
  publicationCommand({ action: 'hold', name: 'unit-publication' }, emit);
  let completed = false;
  const pending = beforeFacadePublication('unit-publication').then(() =>
    completed = true
  );
  await observations.wait((event) =>
    event.kind === 'publication' && event.name === 'unit-publication' &&
    event.state === 'held'
  );
  assertEquals(completed, false);
  publicationCommand({ action: 'release', name: 'unit-publication' }, emit);
  await pending;
  assertEquals(completed, true);
});

Deno.test('facade offline observation waits for every matching live connection', () => {
  const connections = new FacadeHealthConnections<object>();
  const owner = {}, other = {};
  const first = new AbortController(), second = new AbortController();
  const otherOwner = new AbortController(),
    otherPairing = new AbortController();
  let offline = 0;
  connections.connected(owner, 'pairing', first.signal, () => offline++);
  connections.connected(owner, 'pairing', second.signal, () => offline++);
  connections.connected(other, 'pairing', otherOwner.signal, () => {});
  connections.connected(owner, 'other', otherPairing.signal, () => {});
  first.abort();
  assertEquals(offline, 0, 'another live matching connection prevents offline');
  second.abort();
  assertEquals(offline, 1);
  otherOwner.abort();
  otherPairing.abort();
});

Deno.test('facade journal observer forwards a real finite prefix and emits only its committed last fact', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-prefix-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const journal = new Journal(await store.server(), [{
      type: 'control',
      version: 1,
    }]);
    const stream = {
      source: 'home',
      incarnation: 'pairing',
      stream: 'control',
    };
    const records = [];
    for (let sequence = 1; sequence <= 3; sequence++) {
      records.push(
        await journal.append('edge', {
          ...stream,
          type: 'control',
          version: 1,
          operationId: 'prefix-' + sequence,
          payload: { revision: sequence },
        }),
      );
    }
    await journal.receive('home', records);
    const events: unknown[] = [];
    const apply = observeJournalApplication(
      journal.apply,
      (peer, record) => events.push({ peer, record }),
      (operation) => events.push({ operation }),
    );
    const through = { sequence: records[1].sequence, hash: records[1].hash };
    await assertRejects(
      () =>
        apply.call(journal, 'home', stream, (_conn, record) => {
          assertEquals(events, []);
          if (record.sequence === 2) {
            throw new Error('rollback selected prefix');
          }
          return Promise.resolve({ sequence: record.sequence });
        }, through),
      Error,
      'rollback selected prefix',
    );
    assertEquals(events, [{ operation: 'journal apply control' }]);
    assertEquals(
      (await journal.heads('home', 'in', stream)).applied.sequence,
      0,
    );
    events.length = 0;
    const handled: number[] = [];
    assertEquals(
      await apply.call(journal, 'home', stream, (_conn, record) => {
        assertEquals(events, []);
        handled.push(record.sequence);
        return Promise.resolve({ sequence: record.sequence });
      }, through),
      true,
    );
    assertEquals(handled, [1, 2]);
    assertEquals((await journal.heads('home', 'in', stream)).applied, through);
    assertEquals(await journal.pending('home', stream), [records[2]]);
    assertEquals(events, [{ peer: 'home', record: records[1] }]);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
