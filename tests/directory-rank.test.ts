import { assert, assertEquals, assertRejects } from '@std/assert';
import { joinedUsers, listedRooms } from '#engine/server/directory.ts';
import {
  backfillDirectoryRanks,
  rankedDirectoryPage,
  setRankedVisibility,
} from '#engine/server/directory-rank.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { Conn, type Database } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';

async function assertDirectoryRank(db: Database) {
  const rooms = [];
  for (const id of await listedRooms(db)) {
    rooms.push({ id, joined: (await joinedUsers(db, id)).length });
  }
  rooms.sort((a, b) => b.joined - a.joined || a.id.localeCompare(b.id));
  for (
    const offset of [
      1,
      ...Array.from(
        { length: Math.ceil(rooms.length / 100) + 1 },
        (_, i) => i * 100,
      ),
      rooms.length + 5,
    ]
  ) {
    assertEquals(await rankedDirectoryPage(db, offset, 100), {
      total: rooms.length,
      rooms: rooms.slice(offset, offset + 100),
    });
  }
}

Deno.test('CHECKLISTSLOW: publication and membership write work stays bounded as directory grows', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'rank-write-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: historicalServerSchema(60) } });
  let current: typeof store | undefined;
  try {
    const id = (i: number) => `!r${String(i).padStart(4, '0')}:rank.test`;
    await (await store.server()).tx(async (tx) => {
      for (let i = 0; i < 128; i++) {
        await tx.execute("INSERT INTO visibility VALUES(?,'public')", [
          id(i * 2),
        ]);
      }
    });
    await store.close();
    current = await openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
    const db = await current.server();
    for await (const _ of backfillDirectoryRanks(db)) {
      /* resumable batches */
    }
    const query = Conn.prototype.query;
    const execute = Conn.prototype.execute;
    const measure = async (work: () => Promise<unknown>) => {
      let statements = 0, rows = 0;
      Conn.prototype.query = async function (...args) {
        statements++;
        const result = await query.apply(this, args);
        rows += result.length;
        return result;
      };
      Conn.prototype.execute = function (...args) {
        statements++;
        return execute.apply(this, args);
      };
      try {
        await work();
        return { statements, rows };
      } finally {
        Conn.prototype.query = query;
        Conn.prototype.execute = execute;
      }
    };
    const publish = (roomId: string) =>
      measure(() => db.tx((tx) => setRankedVisibility(tx, roomId, 'public')));
    const join = (roomId: string) =>
      measure(() =>
        db.tx((tx) =>
          tx.execute(
            "INSERT INTO memberships VALUES('@a:rank.test',?,'join','$a',1)",
            [roomId],
          )
        )
      );
    const large = await publish(id(129));
    const largeJoin = await join(id(129));
    await assertDirectoryRank(db);
    await db.tx(async (tx) => {
      for (let i = 16; i < 112; i++) {
        // Retain a sparse directory, including ranks around the next insert.
        if (i !== 63 && i !== 64 && i !== 65) {
          await setRankedVisibility(tx, id(i * 2), 'private');
        }
      }
    });
    const small = await publish(id(127));
    const smallJoin = await join(id(127));
    await assertDirectoryRank(db);
    for (const [op, order] of [['>=', 'ASC'], ['<', 'DESC']]) {
      const plan = await db.query(
        `EXPLAIN QUERY PLAN SELECT room_id,order_key FROM directory_rank WHERE order_key${op}? ORDER BY order_key ${order} LIMIT 1`,
        ['8'.repeat(32)],
      );
      const detail = plan.map((row) => String(row.detail)).join('\n');
      assert(
        /SEARCH .*directory_rank_order/i.test(detail) && !/TEMP/i.test(detail),
        detail,
      );
    }
    assertEquals(largeJoin, smallJoin);
    assertEquals(largeJoin, { statements: 1, rows: 0 });
    assert(
      small.rows <= 24 && large.rows <= 24 && large.statements <= 30 &&
        small.statements <= 30,
      `publication work at small/large directories: ${
        JSON.stringify({ small, large })
      }`,
    );

    // Adjacent original 32-digit keys used to trigger an all-room relabel.
    // Compress a neighboring pair to that boundary, preserving its order.
    const right =
      (await db.query('SELECT order_key FROM directory_rank WHERE room_id=?', [
        id(126),
      ]))[0];
    const adjacent = (BigInt('0x' + right.order_key) - 1n).toString(16)
      .padStart(32, '0');
    await db.execute('UPDATE directory_rank SET order_key=? WHERE room_id=?', [
      adjacent,
      id(30),
    ]);
    const before = await db.query(
      'SELECT room_id,order_key FROM directory_rank ORDER BY room_id',
    );
    const denseId = '!r0060:rank.test';
    await publish(denseId);
    const after = await db.query(
      'SELECT room_id,order_key FROM directory_rank ORDER BY room_id',
    );
    assertEquals(after.filter((row) => row.room_id !== denseId), before);
    assert(
      String(after.find((row) => row.room_id === denseId)?.order_key).length >
        32,
    );
    await assertDirectoryRank(db);
  } finally {
    await current?.close();
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('CHECKLISTSLOW: rank migration resumes and keeps the applied facade directory flag', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'rank-migration-' });
  const open = (schema: typeof serverSchema) =>
    openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: schema } });
  const populate = async (tx: Conn) => {
    const ids = [
      '!a:rank.test',
      '!A:rank.test',
      '!a-b:rank.test',
      '!a_b:rank.test',
      '!é:rank.test',
      '!e\u0301:rank.test',
      ...Array.from(
        { length: 250 },
        (_, i) => `!x${i.toString().padStart(3, '0')}:rank.test`,
      ),
    ];
    for (const [i, id] of ids.entries()) {
      await tx.execute("INSERT INTO visibility VALUES(?,'public')", [id]);
      if (i % 3 === 0) {
        await tx.execute(
          "INSERT INTO memberships VALUES('@a:rank.test',?,'join','$join',1)",
          [id],
        );
      }
      if (i % 5 === 0) {
        await tx.execute('INSERT INTO directory VALUES(?,100)', [id]);
      }
    }
    await tx.exec(
      `INSERT INTO facade_streams(peer,direction,source,incarnation,stream,received,applied) VALUES('home','in','home','p','directory',2,1);
       INSERT INTO facade_scopes(incarnation,scope,source_cut,ready) VALUES('p','directory',17,1);
       INSERT INTO facade_records(peer,direction,source,incarnation,stream,sequence,operation_id,hash,record_json,bytes) VALUES
         ('home','in','home','p','directory',1,'applied','a','{"payload":{"view":{"publicRooms":true}}}',0),
         ('home','in','home','p','directory',2,'received','b','{"payload":{"view":{"publicRooms":false}}}',0);`,
    );
  };
  let store = await open(historicalServerSchema(60));
  try {
    await (await store.server()).tx(populate);
    await store.close();
    store = await open(serverSchema);
    const db = await store.server();
    assertEquals(await db.query('SELECT * FROM directory_rank_replica'), [{
      pairing: 'p',
      source_cut: 17,
      public_rooms: 1,
    }]);
    // A 64-room batch must not transfer the existing rank list once per room.
    const query = Conn.prototype.query;
    let rankRows = 0;
    Conn.prototype.query = async function (...args) {
      const rows = await query.apply(this, args);
      if (/\b(?:FROM|JOIN) directory_rank\b/i.test(args[0])) {
        rankRows += rows.length;
      }
      return rows;
    };
    const first = backfillDirectoryRanks(db);
    try {
      assertEquals((await first.next()).done, false);
      await first.return();
    } finally {
      Conn.prototype.query = query;
    }
    assert(
      rankRows <= 64 * 8,
      `rank rows transferred in one batch: ${rankRows}`,
    );
    assertEquals(await db.query('SELECT COUNT(*) AS n FROM directory_rank'), [{
      n: 64,
    }]);
    await assertRejects(
      () => rankedDirectoryPage(db, 0, 10),
      Error,
      'backfill incomplete',
    );
    await store.close();
    store = await open(serverSchema);
    const reopened = await store.server();
    assertEquals(
      await reopened.query(
        'SELECT after_room,complete FROM directory_rank_state',
      ),
      [{ after_room: '!x058:rank.test', complete: 0 }],
    );
    rankRows = 0;
    Conn.prototype.query = async function (...args) {
      const rows = await query.apply(this, args);
      if (/\b(?:FROM|JOIN) directory_rank\b/i.test(args[0])) {
        rankRows += rows.length;
      }
      return rows;
    };
    try {
      for await (const _ of backfillDirectoryRanks(reopened)) {
        // Continue from the durable cursor through multiple batches.
      }
    } finally {
      Conn.prototype.query = query;
    }
    assertEquals(rankRows, 256, 'resume should read the rank inventory once');
    await assertDirectoryRank(reopened);
    const before = await reopened.query(
      'SELECT * FROM directory_rank ORDER BY room_id',
    );
    assertEquals((await backfillDirectoryRanks(reopened).next()).done, true);
    assertEquals(
      await reopened.query('SELECT * FROM directory_rank ORDER BY room_id'),
      before,
    );
    const plan = await reopened.query(
      'EXPLAIN QUERY PLAN SELECT room_id,joined_members FROM directory_rank WHERE listed=1 ORDER BY joined_members DESC,order_key,room_id LIMIT 10 OFFSET 3',
    );
    const explain = plan.map((row) => String(row.detail)).join('\n');
    assert(
      explain.includes('directory_rank_page') && !/TEMP/i.test(explain),
      explain,
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
