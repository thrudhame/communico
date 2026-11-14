import { assertEquals, assertRejects } from '@std/assert';
import { Journal } from '#engine/facade/journal.ts';
import {
  EMPTY_CUT,
  LinkError,
  type LinkRecord,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

const supported = [{ type: 'control', version: 1 }];
const stream = { source: 'home', incarnation: 'home-1', stream: 'control' };
const cut = (record: LinkRecord) => ({
  sequence: record.sequence,
  hash: record.hash,
});
const limits = { maxItems: 100, maxBytes: 10000 };
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-results-' });
  const cfg = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  let store = await openStore(cfg, { schemas: { server: serverSchema } });
  let journal = new Journal(await store.server(), supported);
  const records = [];
  for (const operationId of ['one', 'two', 'three']) {
    records.push(
      await journal.append('edge', {
        ...stream,
        type: 'control',
        version: 1,
        operationId,
        payload: {},
      }),
    );
  }
  await journal.receive('home', records);
  return {
    get journal() {
      return journal;
    },
    records,
    async reopen() {
      await store.close();
      store = await openStore(cfg, { schemas: { server: serverSchema } });
      journal = new Journal(await store.server(), supported);
    },
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('applied ACK cannot advance without every exact terminal result', async () => {
  const f = await fixture();
  const [one, two, three] = f.records;
  try {
    await assertRejects(
      () => f.journal.ack('edge', stream, cut(three), cut(two)),
      LinkError,
    );
    await assertRejects(
      () =>
        f.journal.ack('edge', stream, cut(three), cut(two), [
          { ...cut(one), result: { done: true } },
        ]),
      LinkError,
    );
    assertEquals(await f.journal.result('edge', 'out', stream, cut(one)), null);
    assertEquals(await f.journal.acknowledged('edge', stream), {
      received: EMPTY_CUT,
      applied: EMPTY_CUT,
    });
    await f.journal.ack('edge', stream, cut(three), EMPTY_CUT);
    const results = [{
      ...cut(one),
      result: { pdus: { event: { error: 'rejected' } } },
    }, { ...cut(two), result: null }];
    await f.journal.ack('edge', stream, cut(three), cut(two), results);
    await f.reopen();
    assertEquals(await f.journal.acknowledged('edge', stream), {
      received: cut(three),
      applied: cut(two),
    });
    assertEquals(await f.journal.result('edge', 'out', stream, cut(one)), {
      result: results[0].result,
    });
    assertEquals(await f.journal.result('edge', 'out', stream, cut(two)), {
      result: null,
    });
    assertEquals(
      await f.journal.result('edge', 'out', stream, cut(three)),
      null,
    );
    await f.journal.ack('edge', stream, cut(three), cut(two), results);
    await assertRejects(
      () =>
        f.journal.ack('edge', stream, cut(three), cut(two), [
          { ...cut(one), result: { pdus: {} } },
        ]),
      LinkError,
    );
    await assertRejects(
      () =>
        f.journal.ack('edge', stream, cut(three), cut(three), [
          { ...cut(three), hash: one.hash, result: {} },
        ]),
      LinkError,
    );
    await assertRejects(
      () =>
        f.journal.ack('edge', stream, cut(three), cut(two), [
          { ...cut(three), result: {} },
        ]),
      LinkError,
    );
    assertEquals(
      (await f.journal.acknowledged('edge', stream)).applied,
      cut(two),
    );
  } finally {
    await f.close();
  }
});

Deno.test('terminal results page whole values and stop at the contiguous applied cut', async () => {
  const f = await fixture();
  const [one, two, three] = f.records;
  const large = { value: 'x'.repeat(3000) };
  try {
    await f.journal.complete('home', stream, cut(one), large);
    await f.journal.complete('home', stream, cut(two), { done: true });
    const first = await f.journal.acknowledgement('home', stream, EMPTY_CUT, {
      maxItems: 100,
      maxBytes: 100,
    });
    assertEquals(first, {
      received: cut(three),
      applied: cut(one),
      results: [{ ...cut(one), result: large }],
    });
    await f.journal.ack(
      'edge',
      stream,
      first.received,
      first.applied,
      first.results,
    );
    await f.reopen();
    const second = await f.journal.acknowledgement(
      'home',
      stream,
      first.applied,
      limits,
    );
    assertEquals(second, {
      received: cut(three),
      applied: cut(two),
      results: [{ ...cut(two), result: { done: true } }],
    });
    await f.journal.ack(
      'edge',
      stream,
      second.received,
      second.applied,
      second.results,
    );
    assertEquals(
      await f.journal.acknowledgement('home', stream, cut(two), limits),
      {
        received: cut(three),
        applied: cut(two),
        results: [],
      },
    );
    await assertRejects(
      () => f.journal.acknowledgement('home', stream, cut(three), limits),
      LinkError,
    );
    await assertRejects(
      () =>
        f.journal.acknowledgement('home', stream, {
          sequence: 1,
          hash: two.hash,
        }, limits),
      LinkError,
    );
    assertEquals(await f.journal.result('edge', 'out', stream, cut(one)), {
      result: large,
    });
  } finally {
    await f.close();
  }
});
