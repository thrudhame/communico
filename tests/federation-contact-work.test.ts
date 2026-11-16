import { assert, assertEquals, assertRejects } from '@std/assert';
import { notifyPeerAlive, peerStatus } from '#engine/federation/sender.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { Db } from '#engine/store/db.ts';
import { Turso } from '#engine/store/ffi.ts';

Deno.test('peer contact work: reset only changed pending rows, atomically with the ladder', async () => {
  const dir = await Deno.makeTempDir();
  const ffi = new Turso('./.native/libturso_ffi.so');
  const db = await Db.open(ffi, dir + '/data.db', 65536);
  try {
    await serverSchema.apply(db);
    await db.tx(async (tx) => {
      for (let pos = 1; pos <= 68; pos++) {
        await tx.execute(
          'INSERT INTO outbox(room,pos,destination,event,state,attempts,next_attempt_ms,added_ms) VALUES(?,?,?,?,?,?,?,?)',
          [
            '!contact:test',
            pos,
            pos === 68 ? 'other.test' : 'peer.test',
            '$' + pos,
            pos === 67 ? 'sent' : 'pending',
            3,
            pos <= 64 ? 0 : 1000 + pos,
            100,
          ],
        );
      }
      await tx.execute(
        'INSERT INTO peer_status(destination,failures,next_attempt_ms) VALUES(?,4,9000)',
        ['peer.test'],
      );
    });
    const before = await db.query('SELECT * FROM outbox ORDER BY pos');
    const ladder = await peerStatus(db, 'peer.test');
    const execute = ffi.execute.bind(ffi);
    let fault = true;
    const writes: number[] = [];
    ffi.execute = async (...args: Parameters<typeof ffi.execute>) => {
      const changed = await execute(...args);
      if (args[1].startsWith('UPDATE outbox ')) {
        if (fault) throw new Error('contact rollback');
        writes.push(changed);
      }
      return changed;
    };
    await assertRejects(
      () => notifyPeerAlive(db, 'peer.test'),
      Error,
      'contact rollback',
    );
    assertEquals(await db.query('SELECT * FROM outbox ORDER BY pos'), before);
    assertEquals(await peerStatus(db, 'peer.test'), ladder);
    fault = false;
    const started = performance.now();
    await notifyPeerAlive(db, 'peer.test');
    await notifyPeerAlive(db, 'peer.test');
    console.log(
      JSON.stringify({
        owner: 'notifyPeerAlive',
        writes,
        elapsed_ms: performance.now() - started,
      }),
    );
    const expected = before.map((row) =>
      row.destination === 'peer.test' && row.state === 'pending'
        ? { ...row, next_attempt_ms: 0 }
        : row
    );
    assertEquals(await db.query('SELECT * FROM outbox ORDER BY pos'), expected);
    const after = await peerStatus(db, 'peer.test');
    assertEquals(after.failures, 0);
    assertEquals(after.nextAttemptMs, 0);
    assert(after.lastInboundMs !== null);
    assertEquals(
      writes,
      [2, 0],
      'repeated contact must not rewrite ready history',
    );
  } finally {
    await db.close();
    ffi.close();
    await Deno.remove(dir, { recursive: true });
  }
});
