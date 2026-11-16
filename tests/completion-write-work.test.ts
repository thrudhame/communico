import { assertEquals, assertRejects } from '@std/assert';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';
import type { SchemaProvider } from '#engine/store/create.ts';
import { tenantSchema } from '#engine/tenant/schema.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { roomSchema } from '#engine/room/schema.ts';
import { finishSubmission } from '#engine/tenant/txns.ts';
import { closeSegment } from '#engine/room/segments.ts';
import { claim, finish } from '#engine/tenant/delayed-events.ts';
import { finishPushWork, type PushTarget } from '#engine/server/push-work.ts';

async function fixture(schema: SchemaProvider, fn: (db: Db) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await schema.apply(db);
    await fn(db);
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
}
async function measure(db: Db, owner: string, fn: () => Promise<void>) {
  const execute = db.ffi.execute.bind(db.ffi);
  let writes = 0;
  db.ffi.execute = async (...args: Parameters<Turso['execute']>) => {
    const n = await execute(...args);
    if (args[1].startsWith('UPDATE ')) writes += n;
    return n;
  };
  const start = performance.now();
  try {
    await fn();
  } finally {
    db.ffi.execute = execute;
  }
  console.log(
    JSON.stringify({ owner, writes, elapsed_ms: performance.now() - start }),
  );
  return writes;
}

Deno.test('completion work: delayed recovery retries preserve sending and terminal receipts without rewriting', () =>
  fixture(tenantSchema, async (db) => {
    await db.execute(
      "INSERT INTO delayed_events(id,localpart,room_id,type,content,delay_ms,since_ms,due_ms,room_pos,phase,completed) VALUES('one','a','!r:test','m.room.message','{}',1,1,2,0,'pending',0)",
    );
    await db.tx((tx) => claim(tx, 'one', 2));
    const claimed = await measure(
      db,
      'delayed sending replay',
      () =>
        db.tx(async (tx) => {
          assertEquals((await claim(tx, 'one', 2))?.id, 'one');
        }),
    );
    await db.tx((tx) => finish(tx, 'one'));
    const completed = await measure(
      db,
      'delayed terminal replay',
      () => db.tx((tx) => finish(tx, 'one')),
    );
    assertEquals(claimed, 0);
    assertEquals(completed, 0);
    assertEquals(
      await db.query('SELECT phase,completed,pending_pdu FROM delayed_events'),
      [{ phase: 'sending', completed: 1, pending_pdu: null }],
    );
  }));
Deno.test('completion work: replaying accepted tenant submission does not rewrite its terminal receipt', () =>
  fixture(tenantSchema, async (db) => {
    const device = { localpart: 'a', deviceId: 'PHONE', generation: 1 };
    const endpoint = {
      kind: 'send' as const,
      roomId: '!r:test',
      eventType: 'm.room.message',
    };
    await db.execute(
      "INSERT INTO transactions(localpart,device_id,generation,endpoint,room_id,txn_id,event_id,pending_pdu,completed) VALUES('a','PHONE',1,?,'!r:test','one','$e','{}',0)",
      [JSON.stringify(['send', '!r:test', 'm.room.message'])],
    );
    await db.tx((tx) =>
      finishSubmission(tx, device, endpoint, 'one', '$e', true)
    );
    const n = await measure(
      db,
      'tenant completed submission replay',
      () =>
        db.tx((tx) =>
          finishSubmission(tx, device, endpoint, 'one', '$e', true)
        ),
    );
    assertEquals(
      await db.query('SELECT completed,pending_pdu FROM transactions'),
      [{ completed: 1, pending_pdu: null }],
    );
    assertEquals(n, 0);
    await db.tx((tx) =>
      finishSubmission(tx, device, endpoint, 'one', '$other', true)
    );
    await db.tx((tx) =>
      finishSubmission(tx, device, endpoint, 'one', '$e', false)
    );
    assertEquals(
      (await db.query('SELECT COUNT(*) AS n FROM transactions'))[0].n,
      1,
    );
  }));
Deno.test('completion work: repeated segment closure preserves terminal kind and refuses unknown IDs', () =>
  fixture(roomSchema, async (db) => {
    await db.exec(
      "INSERT INTO segments(id,kind,status) VALUES(1,'stay','open'),(2,'history','open')",
    );
    await db.tx(async (tx) => {
      await closeSegment(tx, 1);
      await closeSegment(tx, 2);
    });
    const n = await measure(
      db,
      'segment terminal replay',
      () =>
        db.tx(async (tx) => {
          await closeSegment(tx, 1);
          await closeSegment(tx, 2);
        }),
    );
    assertEquals(await db.query('SELECT status FROM segments ORDER BY id'), [{
      status: 'closed',
    }, { status: 'complete' }]);
    await assertRejects(
      () => db.tx((tx) => closeSegment(tx, 3)),
      Error,
      'unknown segment',
    );
    assertEquals(n, 0);
  }));
Deno.test('completion work: badge completion only changes retained progress and never clears newer retry state', () =>
  fixture(serverSchema, async (db) => {
    const target = { incarnation: 'one' } as PushTarget;
    await db.execute(
      "INSERT INTO push_badges(incarnation,user,revision,sent_revision,expired_revision,created_ms,attempts,next_ms,error) VALUES('one','@a:test',2,0,0,1,3,100,'retry')",
    );
    const work = {
      event: null,
      badge: { revision: 2, attempts: 3 },
      unread: 0,
    };
    await db.tx((tx) => finishPushWork(tx, target, work));
    const n = await measure(
      db,
      'badge terminal replay',
      () => db.tx((tx) => finishPushWork(tx, target, work)),
    );
    assertEquals(
      await db.query(
        'SELECT sent_revision,attempts,next_ms,error FROM push_badges',
      ),
      [{ sent_revision: 2, attempts: 0, next_ms: 0, error: null }],
    );
    assertEquals(n, 0);
    await db.execute(
      "UPDATE push_badges SET revision=3,attempts=4,next_ms=200,error='new retry'",
    );
    await db.tx((tx) => finishPushWork(tx, target, work));
    assertEquals(
      await db.query(
        'SELECT sent_revision,attempts,next_ms,error FROM push_badges',
      ),
      [{ sent_revision: 2, attempts: 4, next_ms: 200, error: 'new retry' }],
    );
    await db.tx((tx) =>
      finishPushWork(tx, target, {
        ...work,
        badge: { revision: 3, attempts: 4 },
      })
    );
    assertEquals(
      await db.query(
        'SELECT sent_revision,attempts,next_ms,error FROM push_badges',
      ),
      [{ sent_revision: 3, attempts: 0, next_ms: 0, error: null }],
    );
  }));
