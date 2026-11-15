import { assert, assertEquals, assertRejects } from '@std/assert';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { fanoutDeviceChange } from '#engine/server/device-federation.ts';
import {
  completeBatch,
  freezeBatch,
  frozenBatch,
} from '#engine/server/delivery.ts';

const subject = '@alice:logical.test', destination = 'remote.test';
const options = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'device-publications-' });
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  const db = await store.server();
  await db.tx((conn) =>
    reconcileDeviceRoom(
      conn,
      '!room:logical.test',
      [subject, '@bob:remote.test'],
      false,
      null,
      1,
      ['logical.test'],
    )
  );
  return {
    store,
    db,
    dir,
    change: (id: number, prev?: number[], name = String(id)) =>
      db.tx((conn) =>
        fanoutDeviceChange(
          conn,
          subject,
          id,
          JSON.stringify({
            device_id: 'PHONE',
            device_display_name: name,
            ...(prev ? { wire: { streamId: id, prevIds: prev } } : {}),
          }),
        )
      ),
    queued: async () =>
      (await db.query(
        "SELECT source,payload FROM edu_outbox WHERE edu_type='m.device_list_update' ORDER BY enqueue_pos",
      ))
        .map((row) => ({
          source: String(row.source),
          content: JSON.parse(String(row.payload)),
        })),
    async close() {
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('F2 device publication retains lower concurrent IDs and joins every predecessor tip', async () => {
  const f = await fixture();
  try {
    await f.change(10, [0]);
    await f.change(3, [0]);
    const concurrent = await f.queued();
    assertEquals(
      concurrent.map((row) => [row.content.stream_id, row.content.prev_id]),
      [
        [0, []],
        [10, [0]],
        [3, [0]],
      ],
    );
    await f.change(11);
    assertEquals((await f.queued()).at(-1)!.content.prev_id, [3, 10]);
    assertEquals((await f.queued()).at(-1)!.content.wire, undefined);
  } finally {
    await f.close();
  }
});

Deno.test('F2 device publication treats a delayed known predecessor as an ancestor, not a new frontier tip', async () => {
  const f = await fixture();
  try {
    await f.change(30, [20]);
    await f.change(20, [0]);
    await f.change(31);
    assertEquals((await f.queued()).at(-1)!.content.prev_id, [30]);
    const before = await f.queued();
    await f.change(20, [0]);
    assertEquals(await f.queued(), before);
    await assertRejects(
      () => f.change(20, [0], 'substitution'),
      Error,
      'device publication collision',
    );
    assertEquals(await f.queued(), before);
  } finally {
    await f.close();
  }
});

Deno.test('F2 device publication acknowledges exact identities across frozen retry and cold restart', async () => {
  const f = await fixture();
  try {
    await f.change(10, [0]);
    const higher = (await f.queued()).at(-1)!;
    const batch = {
      txnId: 'exact-higher',
      body: 'frozen-higher-bytes',
      rows: [],
      sources: [higher.source],
    };
    assert(await freezeBatch(f.db, destination, batch));
    await f.change(3, [0]);
    const lower = (await f.queued()).at(-1)!;
    await f.store.close();
    const reopened = await openStore(options(f.dir), {
      schemas: { server: serverSchema },
    });
    try {
      const db = await reopened.server();
      assertEquals(await frozenBatch(db, destination), batch);
      await db.tx((conn) => completeBatch(conn, destination, batch));
      assertEquals(
        await db.query(
          'SELECT stream_id,sent FROM device_publications WHERE subject=? AND stream_id IN (3,10) ORDER BY stream_id',
          [subject],
        ),
        [
          { stream_id: 3, sent: 0 },
          { stream_id: 10, sent: 1 },
        ],
      );
      await db.tx((conn) =>
        completeBatch(conn, destination, {
          ...batch,
          txnId: 'exact-lower',
          sources: [lower.source],
        })
      );
      assertEquals(
        await db.query(
          'SELECT stream_id,sent FROM device_publications WHERE subject=? AND stream_id IN (3,10) ORDER BY stream_id',
          [subject],
        ),
        [
          { stream_id: 3, sent: 1 },
          { stream_id: 10, sent: 1 },
        ],
      );
      await db.tx((conn) =>
        fanoutDeviceChange(
          conn,
          subject,
          3,
          JSON.stringify({
            device_id: 'PHONE',
            device_display_name: '3',
            wire: { streamId: 3, prevIds: [0] },
          }),
        )
      );
      assertEquals(
        (await db.query('SELECT source FROM edu_outbox WHERE source=?', [
          lower.source,
        ])).length,
        0,
        'a delivered identity cannot be queued again',
      );
      await db.tx((conn) =>
        fanoutDeviceChange(
          conn,
          subject,
          11,
          JSON.stringify({ device_id: 'PHONE' }),
        )
      );
      const [last] = await db.query(
        'SELECT payload FROM edu_outbox ORDER BY enqueue_pos DESC LIMIT 1',
      );
      assertEquals(JSON.parse(String(last.payload)).prev_id, [3, 10]);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('F2 device publication rejects predecessor cycles without changing frozen work or the frontier', async () => {
  const f = await fixture();
  try {
    await f.change(30, [20]);
    const before = await f.queued();
    await assertRejects(
      () => f.change(20, [30]),
      Error,
      'device publication collision',
    );
    await assertRejects(
      () => f.change(20, [20]),
      Error,
      'device publication collision',
    );
    assertEquals(await f.queued(), before);
    await f.change(20, [0]);
    await f.change(31);
    assertEquals((await f.queued()).at(-1)!.content.prev_id, [30]);
  } finally {
    await f.close();
  }
});

Deno.test('F2 device publication reset isolates new subscription ACKs from an older frozen epoch', async () => {
  const f = await fixture();
  try {
    const reset = (await f.queued())[0];
    const batch = {
      txnId: 'old',
      body: 'frozen-old-bytes',
      rows: [],
      sources: [reset.source],
    };
    await f.db.tx((conn) => completeBatch(conn, destination, batch));
    await f.change(10, [0]);
    const pending = (await f.queued()).at(-1)!;
    assert(
      await freezeBatch(f.db, destination, {
        ...batch,
        sources: [pending.source],
      }),
    );
    await f.db.tx((conn) =>
      reconcileDeviceRoom(
        conn,
        '!room:logical.test',
        [subject],
        false,
        null,
        2,
        ['logical.test'],
      )
    );
    await f.db.tx((conn) =>
      reconcileDeviceRoom(
        conn,
        '!room:logical.test',
        [subject, '@bob:remote.test'],
        false,
        null,
        3,
        ['logical.test'],
      )
    );
    assertEquals(
      (await f.db.query('SELECT epoch,sent_stream FROM device_subscriptions'))[
        0
      ],
      { epoch: 2, sent_stream: null },
    );
    await f.db.tx((conn) =>
      completeBatch(conn, destination, { ...batch, sources: [pending.source] })
    );
    assertEquals(
      (await f.db.query('SELECT epoch,sent_stream FROM device_subscriptions'))[
        0
      ],
      { epoch: 2, sent_stream: null },
    );
    assertEquals(
      (await f.db.query(
        'SELECT epoch,sent FROM device_publications WHERE source=?',
        [pending.source],
      ))[0],
      { epoch: 1, sent: 1 },
    );
    const current = (await f.queued()).at(-1)!;
    await f.db.tx((conn) =>
      completeBatch(conn, destination, {
        ...batch,
        txnId: 'new',
        sources: [current.source],
      })
    );
    assertEquals(
      (await f.db.query('SELECT epoch,sent_stream FROM device_subscriptions'))[
        0
      ],
      { epoch: 2, sent_stream: 0 },
    );
  } finally {
    await f.close();
  }
});

Deno.test('F2 device publication subscription reset uses the latest projection, never the greatest wire number', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'device-reset-cut-' });
  const store = await openStore(options(dir), {
    schemas: { server: serverSchema },
  });
  try {
    const db = await store.server();
    await db.tx(async (conn) => {
      for (const [i, stream] of [10, 3].entries()) {
        await conn.execute(
          'INSERT INTO device_changes VALUES(?,?,?,?,?,?,?,?)',
          [
            i + 1,
            'original-source',
            i + 1,
            subject,
            'PHONE',
            1,
            stream,
            JSON.stringify({
              device_id: 'PHONE',
              device_display_name: String(stream),
            }),
          ],
        );
      }
      await reconcileDeviceRoom(
        conn,
        '!room:logical.test',
        [subject, '@bob:remote.test'],
        false,
        null,
        1,
        ['logical.test'],
      );
    });
    const [row] = await db.query('SELECT payload FROM edu_outbox');
    assertEquals(JSON.parse(String(row.payload)), {
      user_id: subject,
      device_id: 'PHONE',
      device_display_name: '3',
      stream_id: 3,
      prev_id: [],
    });
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F2 device publication upgrade preserves multiple legacy frozen resets at the same scalar cut', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'device-publication-upgrade-' });
  let store = await openStore(options(dir), {
    schemas: {
      server: {
        version: 39,
        apply: async (db) => {
          await serverSchema.apply(db);
          await db.exec(
            'DROP TABLE device_publications; DROP TABLE device_publication_predecessors; DROP TABLE device_publication_frontier',
          );
        },
      },
    },
  });
  try {
    let db = await store.server();
    const payload = JSON.stringify({
      user_id: subject,
      device_id: 'PHONE',
      stream_id: 10,
      prev_id: [],
    });
    const sources = ['old-reset-1', 'old-reset-2'];
    await db.tx(async (conn) => {
      await conn.execute(
        'INSERT INTO device_subscriptions VALUES(?,?,1,2,10,NULL)',
        [subject, destination],
      );
      for (const [i, source] of sources.entries()) {
        await conn.execute(
          "INSERT INTO edu_outbox VALUES(?,?,?,?,'pending',?)",
          [source, destination, 'm.device_list_update', payload, i + 1],
        );
      }
      await conn.execute(
        "UPDATE counters SET value=2 WHERE name='reliable-edus'",
      );
    });
    const batch = {
      txnId: 'legacy-frozen',
      body: 'exact-old-reset-bytes',
      rows: [],
      sources: [sources[0]],
    };
    assert(await freezeBatch(db, destination, batch));
    await store.close();
    store = await openStore(options(dir), {
      schemas: { server: serverSchema },
    });
    db = await store.server();
    assertEquals(await frozenBatch(db, destination), batch);
    assertEquals(
      await db.query(
        'SELECT source,content,sent FROM device_publications ORDER BY source',
      ),
      sources.map((source) => ({ source, content: payload, sent: 0 })),
    );
    await db.tx((conn) => completeBatch(conn, destination, batch));
    assertEquals(
      await db.query(
        'SELECT source,sent FROM device_publications ORDER BY source',
      ),
      [{ source: sources[0], sent: 1 }, { source: sources[1], sent: 0 }],
    );
    await db.tx((conn) =>
      fanoutDeviceChange(
        conn,
        subject,
        3,
        JSON.stringify({
          device_id: 'EDGE',
          wire: { streamId: 3, prevIds: [0] },
        }),
      )
    );
    await db.tx((conn) =>
      fanoutDeviceChange(
        conn,
        subject,
        11,
        JSON.stringify({ device_id: 'PHONE' }),
      )
    );
    const [last] = await db.query(
      'SELECT payload FROM edu_outbox ORDER BY enqueue_pos DESC LIMIT 1',
    );
    assertEquals(JSON.parse(String(last.payload)).prev_id, [3, 10]);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
