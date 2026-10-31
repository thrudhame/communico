// tests/server-wiring.test.ts — the room-write wiring (plan §2 row 5):
// after every successful room write the projection has already run when
// the call returns; a projection failure is logged and left behind (the
// room write stands; the next write catches up).
import { assert, assertEquals } from '@std/assert';
import type { Pdu } from '#engine/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { backfill } from '#engine/room/history.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { ingestInTx, redactEvent, sendLocal } from '#engine/room/ingest.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { invite } from '#engine/room/membership.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { verify } from '#engine/room/verify.ts';
import { sourceOf } from '#engine/server/project.ts';
import { registerRoom } from '#engine/server/registry.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { get } from '#engine/store/watermark.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { genesis } from './fixtures/genesis.ts';
import { testSigner } from './fixtures/signer.ts';
import { fakeFetcher, fakeKeyResolver } from './fixtures/remote.ts';
import { fakeMessage, makeFakeRoom } from './fixtures/remote-room.ts';

installServerHooks();

const LIBRARY = './.native/libturso_ffi.so';

const config = (dir: string) => ({
  dir,
  library: LIBRARY,
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withStore(
  fn: (store: Store) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { room: roomSchema, server: serverSchema },
  });
  try {
    await fn(store);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

async function rows(
  store: Store,
  sql: string,
  values: (string | number)[] = [],
) {
  const server = await store.server();
  return await server.query(sql, values);
}

Deno.test('wiring: createRoom and every later local write project before returning', async () => {
  await withStore(async (store) => {
    const signer = await testSigner();
    const created = await createRoom(store, {
      creator: '@dev:' + signer.serverName,
      name: 'wired',
    }, signer);
    // the full createRoom sequence is already projected
    const feed = await rows(
      store,
      'SELECT event FROM feed WHERE room = ? ORDER BY seq',
      [created.roomId],
    );
    assertEquals(feed.length, 6); // create, join, PL, join_rules, HV, name
    const membership = await rows(
      store,
      'SELECT membership FROM memberships WHERE room = ?',
      [created.roomId],
    );
    assertEquals(membership.length, 1);
    // and the watermark stands at the last change position
    const room = await store.room(created.roomId);
    const last = await room.tx(async (tx) => {
      const r = await tx.query(
        'SELECT pos FROM changes ORDER BY pos DESC LIMIT 1',
      );
      return Number(r[0].pos);
    });
    assertEquals(
      await get(await store.server(), sourceOf(created.roomId)),
      last,
    );
  });
});

Deno.test('wiring: membership ops and redactions project through sendLocal', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!w2:test' });
    // invite via the membership op (authors + ingests via sendLocal)
    await invite(g.room, g.creator, '@bob:remote.test', g.signer);
    const bob = await rows(
      store,
      `SELECT membership FROM memberships WHERE room = ? AND user = '@bob:remote.test'`,
      [g.roomId],
    );
    assertEquals(bob.length, 1);
    assertEquals(bob[0].membership, 'invite');
    // the remote invitee's server is owed the invite already
    const owed = await rows(
      store,
      `SELECT destination FROM outbox WHERE room = ? AND destination = 'remote.test'`,
      [g.roomId],
    );
    assertEquals(owed.length, 1);
    // a message, then its redaction
    const msg = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'take it back' },
      origin_server_ts: 100,
    }, g.signer);
    const feed = await rows(
      store,
      'SELECT event FROM feed WHERE room = ? AND event = ?',
      [g.roomId, msg.eventId],
    );
    assertEquals(feed.length, 1);
    const redaction = await redactEvent(
      g.room,
      g.creator,
      msg.eventId,
      g.signer,
    );
    const effects = await rows(
      store,
      'SELECT target, event FROM redactions WHERE room = ?',
      [g.roomId],
    );
    assertEquals(effects.length, 1);
    assertEquals(effects[0].target, msg.eventId);
    assertEquals(effects[0].event, redaction.eventId);
  });
});

Deno.test('wiring: a projection failure leaves the room write standing; the next write catches up', async () => {
  await withStore(async (store) => {
    const g = await genesis(store, { roomId: '!w3:test' });
    const before = await rows(store, 'SELECT COUNT(*) AS n FROM feed');
    // break the projection for one write
    setRoomHooks({
      project: () => Promise.reject(new Error('boom')),
      register: registerRoom,
    });
    const first = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'write one' },
      origin_server_ts: 100,
    }, g.signer);
    assertEquals(first.standing, 'accepted'); // the room write succeeded
    assertEquals(
      (await rows(store, 'SELECT COUNT(*) AS n FROM feed'))[0].n,
      before[0].n, // unprojected — the failure was logged, not thrown
    );
    // restore: the NEXT write projects the backlog (and itself)
    installServerHooks();
    const second = await sendLocal(g.room, {
      type: 'm.room.message',
      sender: g.creator,
      content: { msgtype: 'm.text', body: 'write two' },
      origin_server_ts: 101,
    }, g.signer);
    const feed = await rows(
      store,
      'SELECT event FROM feed WHERE room = ? AND event IN (?, ?)',
      [g.roomId, first.eventId, second.eventId],
    );
    assertEquals(feed.length, 2);
  });
});

Deno.test('wiring: remote ingest and backfill project before returning', async () => {
  await withStore(async (store) => {
    // a fake remote room; its genesis lands live here, one message
    // backfills into the history segment
    const fr = await makeFakeRoom({ roomId: '!w4:remote.test' });
    const genesisIds = [...fr.events.values()].slice(0, 5);
    await fakeMessage(fr, 'the older one');
    await fakeMessage(fr, 'the old one');
    const tip = await fakeMessage(fr, 'the tip');
    const room = await openRoom(store, fr.roomId, { create: true });
    const keys = fakeKeyResolver(fr.server);
    const create = await verify(genesisIds[0], fr.version, keys, {
      roomId: fr.roomId,
    });
    await withRoomLock(fr.roomId, () =>
      room.tx(async (tx) => {
        const empty = await tx.materialize.newGroup(null, []);
        await tx.segments.create({ kind: 'stay', opening_group: empty });
        const created = await ingestInTx(tx, fr.roomId, create.pdu, {
          remote: {
            origin: fr.server.name,
            self: 'test',
            oversized: create.oversized,
            ungroundedMs: 3_600_000,
          },
        });
        assertEquals(created.standing, 'accepted');
      }));
    const deps: RemoteDeps = {
      keys,
      fetcher: fakeFetcher({}).fetcher,
      self: 'test',
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    };
    // ingestRemote: the remaining genesis events project before return
    const rest = await ingestRemote(
      room,
      genesisIds.slice(1),
      fr.server.name,
      deps,
    );
    for (const outcome of rest) assertEquals(outcome.outcome, 'accepted');
    const liveFeed = await rows(
      store,
      'SELECT COUNT(*) AS n FROM feed WHERE room = ?',
      [room.id],
    );
    assertEquals(Number(liveFeed[0].n), 5);
    // the chase for the tip, then the backfill — both wired
    const gapTip = String(tip.prev_events![0]);
    deps.fetcher = fakeFetcher({
      missingEvents: [],
      stateIds: new Map([[gapTip, fr.stateIdsAt(gapTip)!]]),
      event: new Map(
        [...fr.events.entries()].map(([id, pdu]) => [id, pdu] as [string, Pdu]),
      ),
    }).fetcher;
    assertEquals(
      (await ingestRemote(room, [tip], fr.server.name, deps))[0].outcome,
      'accepted',
    );
    deps.fetcher = fakeFetcher({
      backfill: (from, limit) => fr.backfillPdus(from, limit),
    }).fetcher;
    const oldest = String(fr.events.get(gapTip)!.prev_events![0]);
    const filled = await backfill(
      room,
      { from: [oldest], limit: 5, via: fr.server.name },
      deps,
    );
    assert(filled.outcome === 'filled' || filled.outcome === 'complete');
    // the backfilled message is indexed with no seq — before any manual
    // project() call
    const history = await rows(
      store,
      `SELECT event, seq FROM event_index
       WHERE room = ? AND event NOT IN (SELECT event FROM feed WHERE room = ?)`,
      [room.id, room.id],
    );
    assertEquals(history.length, 1);
    assertEquals(history[0].seq, null);
    const feed = await rows(
      store,
      'SELECT COUNT(*) AS n FROM feed WHERE room = ?',
      [room.id],
    );
    assertEquals(Number(feed[0].n), 7); // 5 genesis + gap tip + tip
  });
});
