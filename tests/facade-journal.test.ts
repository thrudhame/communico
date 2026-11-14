import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { Journal } from '#engine/facade/journal.ts';
import {
  EMPTY_CUT,
  LinkError,
  type LinkRecord,
  negotiate,
  recordHash,
  recordOf,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';

const capabilities = [{ type: 'control', version: 1 }];
const stream = { source: 'home', incarnation: 'home-1', stream: 'control' };
const cut = (record: LinkRecord) => ({
  sequence: record.sequence,
  hash: record.hash,
});
const limits = { maxBytes: 10000, maxItems: 100 };
const cfg = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
async function fixture(fn: (store: Store, journal: Journal) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-journal-' });
  const store = await openStore(cfg(dir), {
    schemas: { server: serverSchema },
  });
  try {
    await fn(store, new Journal(await store.server(), capabilities));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}
function input(operationId: string, payload: unknown = { roster: [] }) {
  return { ...stream, type: 'control', version: 1, operationId, payload };
}
function rewrite(record: LinkRecord, patch: Partial<LinkRecord>) {
  const { hash: _hash, ...body } = { ...record, ...patch };
  return { ...body, hash: recordHash(body) };
}

Deno.test('link negotiation refuses skew and identity before record mutation', () => {
  const hello = {
    protocol: { major: 1, minor: 9 },
    server: 'logical.test',
    required: capabilities,
  };
  assertEquals(negotiate(hello, 'logical.test', capabilities).protocol, {
    major: 1,
    minor: 0,
  });
  assertEquals(
    assertThrows(() =>
      negotiate(
        { ...hello, protocol: { major: 2, minor: 0 } },
        'logical.test',
        capabilities,
      ), LinkError).code,
    'LINK_VERSION_MISMATCH',
  );
  assertEquals(
    assertThrows(() =>
      negotiate(
        { ...hello, required: [{ type: 'sql', version: 1 }] },
        'logical.test',
        capabilities,
      ), LinkError).code,
    'LINK_CAPABILITY_MISMATCH',
  );
  assertEquals(
    assertThrows(() => negotiate(hello, 'other.test', capabilities), LinkError)
      .status,
    403,
  );
});

Deno.test('journal append is durable/idempotent and refuses changed operation identity', async () => {
  await fixture(async (_store, journal) => {
    const one = await journal.append('edge', input('one'));
    assertEquals(one.sequence, 1);
    assertEquals(one.previous, '');
    assertEquals(await journal.append('edge', input('one')), one);
    await assertRejects(
      () => journal.append('edge', input('one', { roster: ['changed'] })),
      LinkError,
    );
    const two = await journal.append('edge', input('two'));
    assertEquals(two.sequence, 2);
    assertEquals(two.previous, one.hash);
    assertEquals(recordOf(two), two);
    assertThrows(
      () => recordOf({ ...two, payload: { changed: true } }),
      LinkError,
    );
    assertEquals(
      (await journal.page('edge', 'out', stream, 0, limits)).records,
      [one, two],
    );
  });
});

Deno.test('journal receipt is not application; holes and changed replay roll back the whole page', async () => {
  await fixture(async (_store, journal) => {
    const one = await journal.append('edge', input('one'));
    const two = await journal.append('edge', input('two'));
    await assertRejects(
      () => journal.receive('home', [one, rewrite(two, { sequence: 3 })]),
      LinkError,
    );
    assertEquals(
      (await journal.heads('home', 'in', stream)).received,
      EMPTY_CUT,
    );
    const received = await journal.receive('home', [one, two]);
    assertEquals(received?.received, cut(two));
    assertEquals(received?.applied, EMPTY_CUT);
    assertEquals(await journal.receive('home', [one, two]), received);
    await assertRejects(
      () =>
        journal.receive('home', [rewrite(one, { payload: { changed: true } })]),
      LinkError,
    );
    assertEquals(await journal.next('home', stream), one);
    await assertRejects(
      () => journal.complete('home', stream, cut(two), {}),
      LinkError,
    );
    assertEquals(
      (await journal.complete('home', stream, cut(one), { accepted: true }))
        .applied,
      cut(one),
    );
    assertEquals(
      (await journal.complete('home', stream, cut(one), { accepted: true }))
        .applied,
      cut(one),
    );
    await assertRejects(
      () => journal.complete('home', stream, cut(one), { accepted: false }),
      LinkError,
    );
    assertEquals(await journal.next('home', stream), two);
  });
});

Deno.test('server domain application and result/cut commit atomically; another stream progresses', async () => {
  await fixture(async (store, journal) => {
    const one = await journal.append('edge', input('one'));
    const otherStream = { ...stream, stream: 'room:other' };
    const other = await journal.append('edge', {
      ...input('other'),
      ...otherStream,
    });
    await journal.receive('home', [one]);
    await journal.receive('home', [other]);
    const failure = new Error('domain failed');
    await assertRejects(
      () =>
        journal.apply('home', stream, async (conn) => {
          await conn.execute('INSERT INTO counters(name,value) VALUES(?,?)', [
            'facade-applied',
            1,
          ]);
          throw failure;
        }),
      Error,
      'domain failed',
    );
    assertEquals(
      await (await store.server()).query(
        'SELECT value FROM counters WHERE name=?',
        ['facade-applied'],
      ),
      [],
    );
    assertEquals(
      (await journal.heads('home', 'in', stream)).applied,
      EMPTY_CUT,
    );
    assertEquals(
      await journal.apply(
        'home',
        otherStream,
        () => Promise.resolve({ terminal: true }),
      ),
      true,
    );
    assertEquals(
      (await journal.heads('home', 'in', otherStream)).applied,
      cut(other),
    );
    assertEquals(
      await journal.apply('home', stream, async (conn) => {
        await conn.execute('INSERT INTO counters(name,value) VALUES(?,?)', [
          'facade-applied',
          1,
        ]);
        return { terminal: true };
      }),
      true,
    );
    assertEquals(
      await journal.apply('home', stream, () => {
        throw new Error('must not reapply');
      }),
      false,
    );
    assertEquals(
      await (await store.server()).query(
        'SELECT value FROM counters WHERE name=?',
        ['facade-applied'],
      ),
      [{ value: 1 }],
    );
  });
});

Deno.test('journal ACK names exact received/applied digests and never deletes unprotected bytes', async () => {
  await fixture(async (_store, journal) => {
    const one = await journal.append('edge', input('one'));
    const two = await journal.append('edge', input('two'));
    await assertRejects(
      () => journal.ack('edge', stream, cut(one), cut(two)),
      LinkError,
    );
    await assertRejects(
      () =>
        journal.ack('edge', stream, { sequence: 2, hash: one.hash }, EMPTY_CUT),
      LinkError,
    );
    const result = { ...cut(one), result: { done: true } };
    assertEquals(
      await journal.ack('edge', stream, cut(two), cut(one), [result]),
      {
        received: cut(two),
        applied: cut(one),
      },
    );
    assertEquals(await journal.ack('edge', stream, cut(two), cut(one)), {
      received: cut(two),
      applied: cut(one),
    });
    await assertRejects(
      () => journal.ack('edge', stream, cut(one), cut(one)),
      LinkError,
    );
    await journal.ack('edge', stream, cut(two), cut(two), [{
      ...cut(two),
      result: { done: true },
    }]);
    assertEquals(
      (await journal.page('edge', 'out', stream, 0, limits)).records,
      [one, two],
    );
    await assertRejects(
      () => journal.page('edge', 'out', stream, 3, limits),
      LinkError,
    );
  });
});

Deno.test('page byte target preserves an oversized singleton and its exact tail', async () => {
  await fixture(async (_store, journal) => {
    const one = await journal.append(
      'edge',
      input('one', { large: 'x'.repeat(3000) }),
    );
    const two = await journal.append('edge', input('two'));
    const first = await journal.page('edge', 'out', stream, 0, {
      maxBytes: 100,
      maxItems: 100,
    });
    assertEquals(first.records, [one]);
    assertEquals(first.head, cut(two));
    assertEquals(
      (await journal.page('edge', 'out', stream, 1, limits)).records,
      [two],
    );
  });
});

Deno.test('unknown capabilities, duplicate operations and mixed streams do not mutate received cuts', async () => {
  await fixture(async (_store, journal) => {
    const one = await journal.append('edge', input('one'));
    const two = await journal.append('edge', input('two'));
    const unsupported = rewrite(one, { type: 'sql' });
    await assertRejects(
      () => journal.receive('home', [unsupported]),
      LinkError,
      'unsupported record type',
    );
    await assertRejects(
      () =>
        journal.receive('home', [
          one,
          rewrite(two, { operationId: one.operationId }),
        ]),
      LinkError,
    );
    await assertRejects(
      () => journal.receive('home', [one, rewrite(two, { stream: 'other' })]),
      LinkError,
    );
    assertEquals(await journal.streams('home', 'in'), []);
  });
});

Deno.test('reopen preserves received/unapplied tail, completed results and export ACKs', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-reopen-' });
  let store = await openStore(cfg(dir), { schemas: { server: serverSchema } });
  try {
    let journal = new Journal(await store.server(), capabilities);
    const one = await journal.append('edge', input('one'));
    const two = await journal.append('edge', input('two'));
    await journal.receive('home', [one, two]);
    await journal.complete('home', stream, cut(one), { done: true });
    await journal.ack('edge', stream, cut(two), cut(one), [{
      ...cut(one),
      result: { done: true },
    }]);
    await store.close();
    store = await openStore(cfg(dir), { schemas: { server: serverSchema } });
    journal = new Journal(await store.server(), capabilities);
    assertEquals(await journal.heads('home', 'in', stream), {
      ...stream,
      received: cut(two),
      applied: cut(one),
    });
    assertEquals(await journal.next('home', stream), two);
    assertEquals(
      (await journal.complete('home', stream, cut(one), { done: true }))
        .applied,
      cut(one),
    );
    await assertRejects(
      () => journal.ack('edge', stream, cut(one), EMPTY_CUT),
      LinkError,
    );
    assertEquals(
      (await journal.page('edge', 'out', stream, 0, limits)).records,
      [one, two],
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('v24 migration adds journal without changing existing room/transaction truth', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-migration-' });
  // Reconstruct v24 by removing every table added since that boundary. The
  // journal and enrollment migrations must both run against genuine old state.
  let store = await openStore(cfg(dir), { schemas: { server: serverSchema } });
  try {
    const server = await store.server();
    await server.tx(async (conn) => {
      await conn.exec(
        'DROP TABLE runtime_identity; DROP TABLE facade_pairings; DROP TABLE facade_control; DROP TABLE facade_export_acks; DROP TABLE facade_records; DROP TABLE facade_streams; DROP TABLE facade_node;',
      );
      await conn.execute('UPDATE meta SET v=? WHERE k=?', [
        '24',
        'schema_version',
      ]);
      await conn.execute(
        'INSERT INTO federation_txns(origin,txn_id,received_ms,response) VALUES(?,?,?,?)',
        ['remote.test', 'retained', 1, '{"pdus":{}}'],
      );
    }, { mode: 'deferred' });
    await store.close();
    store = await openStore(cfg(dir), { schemas: { server: serverSchema } });
    assertEquals(
      await (await store.server()).query(
        'SELECT txn_id,response FROM federation_txns',
      ),
      [{ txn_id: 'retained', response: '{"pdus":{}}' }],
    );
    const journal = new Journal(await store.server(), capabilities);
    assertEquals(
      (await journal.append('edge', input('after-migration'))).sequence,
      1,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
