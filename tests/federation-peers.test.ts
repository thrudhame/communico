// tests/federation-peers.test.ts — the roster, the blocks and the door
// log over a real server file: CRUD, witness selection (operator/approval
// by seniority, keyname excluded), room-server witnesses by joined-member
// seq while we are in the room, glob blocks, pending coalesce/cap/expiry.
// (The roster half of doltgres tests/federation-gate.test.ts, restored;
// the gate/admission half is 4c-2.)
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import {
  addBlock,
  addPeer,
  isBlocked,
  listBlocks,
  listPeers,
  listPending,
  listWitnesses,
  lookupPeer,
  recordPending,
  removeBlock,
  removePeer,
} from '#engine/federation/peers.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type Store } from '#engine/store/index.ts';

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(
    {
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    },
    { schemas: { server: serverSchema } },
  );
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('peers: add/lookup/update/remove; a roster row kills the pending claim', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await addPeer(server, {
      name: 'a.test',
      host: '10.0.0.1',
      port: 8449,
      trust: 'ca',
      addedBy: 'operator',
      note: 'first',
    });
    const row = await lookupPeer(server, 'a.test');
    assert(row !== null);
    assertEquals(row.host, '10.0.0.1');
    assertEquals(row.port, 8449);
    assertEquals(row.added_by, 'operator');
    assertEquals(row.note, 'first');
    await recordPending(server, 'a.test', 'outbound', false, 'knock');
    assertEquals((await listPending(server)).length, 1);
    // an upsert replaces the row and clears the pending claim
    await addPeer(server, {
      name: 'a.test',
      host: null,
      port: null,
      trust: 'pinned',
      pin: 'ff',
      addedBy: 'approval',
    });
    const updated = await lookupPeer(server, 'a.test');
    assert(updated !== null);
    assertEquals(updated.host, null);
    assertEquals(updated.trust, 'pinned');
    assertEquals(updated.pin_spki_sha256, 'ff');
    assertEquals(updated.added_by, 'approval');
    assertEquals((await listPending(server)).length, 0);
    assertEquals((await listPeers(server)).map((p) => p.name), ['a.test']);
    assertEquals(await removePeer(server, 'a.test'), true);
    assertEquals(await removePeer(server, 'a.test'), false);
    assertEquals(await lookupPeer(server, 'a.test'), null);
  });
});

Deno.test('witnesses: only operator/approval rows, ordered by seniority; keyname excluded', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await addPeer(server, {
      name: 'user-added.test',
      host: null,
      port: null,
      trust: 'ca',
      addedBy: '@alice:localhost',
    });
    await addPeer(server, {
      name: 'op1.test',
      host: null,
      port: null,
      trust: 'ca',
      addedBy: 'operator',
    });
    await addPeer(server, {
      name: 'op2.test',
      host: null,
      port: null,
      trust: 'ca',
      addedBy: 'operator',
    });
    await addPeer(server, {
      name: 'approved.test',
      host: null,
      port: null,
      trust: 'ca',
      addedBy: 'approval',
    });
    await addPeer(server, {
      name: 'keyname.test',
      host: '127.0.0.1',
      port: 8449,
      trust: 'keyname',
      addedBy: 'operator',
    });
    const witnesses = await listWitnesses(server);
    // seniority = oldest added first (op1 added after user-added, before op2)
    assertEquals(witnesses.filter((w) => w === 'user-added.test').length, 0);
    assertEquals(witnesses.filter((w) => w === 'keyname.test').length, 0);
    assert(witnesses.includes('op1.test'));
    assert(witnesses.includes('op2.test'));
    assert(witnesses.includes('approved.test'));
  });
});

Deno.test('witnesses: the room servers join the set by joined-member seniority while we are in the room', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await addPeer(server, {
      name: 'op1.test',
      host: null,
      port: null,
      trust: 'ca',
      addedBy: 'operator',
    });
    // memberships: us + two remotes joined, one left, one roster-dupe
    const join = (
      user: string,
      room: string,
      membership: string,
      seq: number,
    ) =>
      server.execute(
        'INSERT INTO memberships(user, room, membership, event, seq) VALUES(?,?,?,?,?) ON CONFLICT(user, room) DO UPDATE SET membership = excluded.membership, event = excluded.event, seq = excluded.seq',
        [user, room, membership, '$e' + seq, seq],
      );
    await join('@dev:localhost', '!r:test', 'join', 1);
    await join('@b:beta.test', '!r:test', 'join', 3);
    await join('@a:alpha.test', '!r:test', 'join', 2);
    await join('@x:gone.test', '!r:test', 'leave', 4);
    await join('@o:op1.test', '!r:test', 'join', 5);
    const witnesses = await listWitnesses(server, {
      roomId: '!r:test',
      excludeName: 'stranger.test',
    });
    // roster first, then the room's servers by earliest joined seq —
    // minus ourselves, the excluded name, leavers and roster rows
    assertEquals(witnesses, ['op1.test', 'alpha.test', 'beta.test']);
    // a room we are not in nominates nobody
    const notIn = await listWitnesses(server, { roomId: '!elsewhere:test' });
    assertEquals(notIn, ['op1.test']);
    // the excluded name drops out of the room set
    const excluded = await listWitnesses(server, {
      roomId: '!r:test',
      excludeName: 'alpha.test',
    });
    assertEquals(excluded, ['op1.test', 'beta.test']);
  });
});

Deno.test('blocks: glob patterns refuse names; list and remove', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await addBlock(server, '*.bad.test', 'malware');
    await addBlock(server, 'exact.test', null);
    assertEquals(await isBlocked(server, 'a.bad.test'), true);
    assertEquals(await isBlocked(server, 'deep.a.bad.test'), true);
    assertEquals(await isBlocked(server, 'exact.test'), true);
    assertEquals(await isBlocked(server, 'bad.test'), false);
    assertEquals(await isBlocked(server, 'good.test'), false);
    const blocks = await listBlocks(server);
    assertEquals(blocks.length, 2);
    assertEquals(await removeBlock(server, '*.bad.test'), true);
    assertEquals(await isBlocked(server, 'a.bad.test'), false);
  });
});

Deno.test('pending: coalesce within keyfailminutes; verified OR-folds', async () => {
  await withStore(async (store) => {
    const server = await store.server();
    await recordPending(server, 'a.test', 'inbound', false, '/x');
    await recordPending(server, 'a.test', 'inbound', false, '/y');
    let rows = await listPending(server);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].count, 2);
    assertEquals(rows[0].detail, '/y');
    assertEquals(rows[0].verified, false);
    // a verified sighting OR-folds into the same row
    await recordPending(server, 'a.test', 'inbound', true, '/z');
    rows = await listPending(server);
    assertEquals(rows[0].verified, true);
    assertEquals(rows[0].count, 3);
  });
});

Deno.test('pending: hard cap evicts the oldest unverified row; expiry prunes', async () => {
  setConfigForTests({ federation: { pendingmax: 3, pendingdays: 30 } });
  await withStore(async (store) => {
    const server = await store.server();
    for (const [i, name] of ['b.test', 'c.test', 'd.test'].entries()) {
      await recordPending(server, name, 'outbound', false, null);
      await server.execute(
        'UPDATE federation_pending SET last_ms = ? WHERE name = ?',
        [Date.now() - 1000 * (3 - i), name],
      );
    }
    // the fourth write evicts the oldest (b.test)
    await recordPending(server, 'e.test', 'outbound', false, null);
    const unverified = (await listPending(server)).filter((r) => !r.verified);
    assertEquals(unverified.length, 3);
    assertEquals(
      unverified.some((r) => r.name === 'b.test'),
      false,
      'oldest evicted',
    );
  });
  await withStore(async (store) => {
    const server = await store.server();
    await recordPending(server, 'old.test', 'outbound', false, null);
    await server.execute(
      'UPDATE federation_pending SET last_ms = ? WHERE name = ?',
      [Date.now() - 31 * 86_400_000, 'old.test'],
    );
    // the next unverified write prunes the expired row
    await recordPending(server, 'f.test', 'outbound', false, null);
    const names = (await listPending(server)).map((r) => r.name);
    assertEquals(names.includes('old.test'), false, 'expired pruned');
    assertEquals(names.includes('f.test'), true);
  });
  setConfigForTests({ federation: { pendingmax: 10000, pendingdays: 30 } });
});
