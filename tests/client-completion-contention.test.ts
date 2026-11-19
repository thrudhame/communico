import { assert, assertEquals } from '@std/assert';
import { type ConflictStats, Conn, Db } from '#engine/store/db.ts';
import { createRoom } from '#engine/room/create.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { startHttp } from '#tests/http-app.ts';

Deno.test('client completion: parallel local sends into one tenant do not share a hot write', async () => {
  const http = await startHttp();
  const { app } = http;
  const query = Conn.prototype.query;
  const tx = Db.prototype.tx;
  let release!: () => void;
  const snapshotsTogether = new Promise<void>((resolve) => release = resolve);
  try {
    const alice = await http.registerTestUser('completion-parallel', 'pw');
    const device = await deviceIdentity(
      app.tenant,
      'completion-parallel',
      alice.device_id!,
    );
    const count = 4;
    const rooms = [];
    for (let i = 0; i < count; i++) {
      rooms.push(
        await createRoom(app.store, {
          creator: alice.user_id,
          preset: 'public_chat',
        }, app.tenant.signer()),
      );
    }
    const db = await app.store.tenant(app.tenant.serverName);
    const observed = new Map<Db, ConflictStats>();
    Db.prototype.tx = function <T>(...args: Parameters<Db['tx']>): Promise<T> {
      if (this.path === db.path && !observed.has(this)) {
        observed.set(this, this.conflictStats());
      }
      return tx.apply(this, args) as Promise<T>;
    };
    let snapshots = 0;
    Conn.prototype.query = async function (sql, values = []) {
      const rows = await query.call(this, sql, values);
      if (
        sql.startsWith('SELECT through FROM client_completion_cuts') &&
        values[0] === device.localpart
      ) {
        // Every independent room's finish captures its native snapshot before
        // any may advance its marker. This forces the old shared allocator to
        // collide, rather than relying on scheduling speed or sleeps.
        if (++snapshots === count) release();
        await snapshotsTogether;
      }
      return rows;
    };
    const results = await Promise.all(rooms.map(async (room, i) => {
      const response = await http.matrix(
        new Request(
          'http://x/_matrix/client/v3/rooms/' +
            encodeURIComponent(room.roomId) + '/send/m.room.message/parallel-' +
            i,
          {
            method: 'PUT',
            headers: { Authorization: 'Bearer ' + alice.access_token },
            body: JSON.stringify({ msgtype: 'm.text', body: 'parallel-' + i }),
          },
        ),
      );
      return { status: response.status, body: await response.json() };
    }));
    const conflicts = [...observed].reduce(
      (sum, [owner, before]) =>
        sum + owner.conflictStats().conflicts - before.conflicts,
      0,
    );
    const retries = [...observed].reduce(
      (sum, [owner, before]) =>
        sum + owner.conflictStats().retries - before.retries,
      0,
    );
    const exhausted = [...observed].reduce(
      (sum, [owner, before]) =>
        sum + owner.conflictStats().exhausted - before.exhausted,
      0,
    );
    console.log(
      'CLIENT_COMPLETION_CONFLICT_CONTRACT',
      JSON.stringify({
        count,
        snapshots,
        conflicts,
        retries,
        exhausted,
        statuses: results.map((r) => r.status),
      }),
    );
    assert(snapshots >= count);
    assertEquals(results.map((r) => r.status), Array(count).fill(200));
    assertEquals(new Set(results.map((r) => r.body.event_id)).size, count);
    const pending = await app.tenant.tx((tx) => tx.completion.pending(device));
    assertEquals(
      pending.map((cut) => cut.roomId).sort(),
      rooms.map((r) => r.roomId).sort(),
    );
    const receipts = await db.query(
      'SELECT event_id FROM transaction_completions',
    );
    assertEquals(
      receipts.map((r) => r.event_id).sort(),
      results.map((r) => r.body.event_id).sort(),
    );
    assertEquals(
      conflicts,
      0,
      'independent local sends must not create tenant native write conflicts',
    );
    assertEquals(retries, 0);
    assertEquals(exhausted, 0);
  } finally {
    release();
    Conn.prototype.query = query;
    Db.prototype.tx = tx;
    await http.close();
  }
});
