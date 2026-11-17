import { assertEquals, assertRejects } from '@std/assert';
import {
  beforeFacadePublication,
  FacadeHealthConnections,
  FacadeObservations,
  facadeProcess,
  observeJournalApplication,
  publicationCommand,
} from './helpers/facade-process.ts';
import { recordHash } from '#engine/facade/protocol.ts';
import { facadeTls } from './support/facade-tls.ts';
import { Journal } from '#engine/facade/journal.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';

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
  await Promise.resolve();
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
  await Promise.resolve();
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
