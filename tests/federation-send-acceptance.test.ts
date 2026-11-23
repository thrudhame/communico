// Inbound /send answers at durable acceptance. Publication belongs to the
// store's completion owner (and startup discovery), never to the request.
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import {
  receiveTransaction,
  type TransactionDeps,
} from '#engine/federation/transactions.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { setRoomHooks } from '#engine/room/hooks.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { completionService } from '#engine/server/completion.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { authAt } from '#tests/fixtures/auth.ts';
import { type Genesis, genesis } from '#tests/fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from '#tests/fixtures/remote.ts';
import { holdPublication } from '#tests/support/hold-publication.ts';

installServerHooks();
const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});
const schemas = { room: roomSchema, server: serverSchema };

// Watchdog only: it can fail a hung request, never deliver a result.
function guard<T>(task: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(what)), 10000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function joinedPeer(store: Store, g: Genesis) {
  const peer = await makeRemoteServer('remote.test');
  const user = '@remote:remote.test';
  const member = {
    type: 'm.room.member',
    sender: user,
    state_key: user,
    content: { membership: 'join' },
  };
  const join = await remoteEvent(g.roomId, peer, '11', {
    ...member,
    prev_events: [g.tipId],
    auth_events: await authAt(g.room, member, g.tipId),
  });
  const deps: TransactionDeps = {
    store,
    self: 'test',
    keys: fakeKeyResolver(peer),
    fetcher: fakeFetcher({}).fetcher,
    edus: { dispatch: () => Promise.resolve() },
  };
  assertEquals(
    (await ingestRemote(g.room, [join], peer.name, {
      ...deps,
      limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
      ungroundedMs: 3_600_000,
    }))[0].outcome,
    'accepted',
  );
  const message = await remoteEvent(g.roomId, peer, '11', {
    type: 'm.room.message',
    sender: user,
    content: { msgtype: 'm.text', body: 'accepted before published' },
    prev_events: [join.event_id!],
    auth_events: await authAt(g.room, {
      type: 'm.room.message',
      sender: user,
      content: {},
    }, join.event_id!),
  });
  return { peer, deps, message };
}

function transaction(origin: string, pdu: Pdu) {
  return {
    origin,
    origin_server_ts: 1,
    pdus: [pdu],
    edus: [],
  };
}

async function feedRows(store: Store, roomId: string, eventId: string) {
  return await (await store.server()).query(
    'SELECT event FROM feed WHERE room=? AND event=?',
    [roomId, eventId],
  );
}

Deno.test('inbound send: answers per-PDU results while publication is held, then publishes once', async () => {
  const root = await Deno.makeTempDir();
  const store = await openStore(config(root), { schemas });
  setConfigForTests({ federation: { missingwaitms: 0 } });
  let hold: ReturnType<typeof holdPublication> | undefined;
  try {
    const g = await genesis(store, {
      roomId: '!send-held:test',
      joinRule: 'public',
    });
    const { peer, deps, message } = await joinedPeer(store, g);
    const eventId = message.event_id!;
    hold = holdPublication({ server: await store.server() }, g.roomId);
    const answer = await guard(
      receiveTransaction(
        peer.name,
        'held',
        transaction(peer.name, message),
        deps,
      ),
      'inbound /send waited for held publication',
    );
    assertEquals(answer, { status: 200, body: { pdus: { [eventId]: {} } } });
    const room = await openRoom(store, g.roomId);
    assertEquals(
      (await room.tx((tx) => tx.events.getStatus(eventId)))?.standing,
      'accepted',
    );
    await guard(hold.entered, 'accepted event never reached publication');
    assertEquals(await feedRows(store, g.roomId, eventId), []);
    // An internal consumer of published state waits on its exact obligation.
    const target = await room.tx((tx) => tx.completion.capture());
    let completed = false;
    const consumer = completionService(store).wait(
      target,
      'completion',
      undefined,
      'test',
    ).then(() => {
      completed = true;
    });
    assert(!completed);
    hold.release();
    await guard(consumer, 'released publication did not complete');
    assertEquals(await feedRows(store, g.roomId, eventId), [{
      event: eventId,
    }]);
    const replay = await receiveTransaction(
      peer.name,
      'held',
      transaction(peer.name, message),
      deps,
    );
    assertEquals(replay, answer);
    assertEquals(await feedRows(store, g.roomId, eventId), [{
      event: eventId,
    }]);
  } finally {
    hold?.release();
    hold?.restore();
    setConfigForTests({ federation: { missingwaitms: 750 } });
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test('inbound send: an answered acceptance publishes once after a restart before publication', async () => {
  const root = await Deno.makeTempDir();
  let store = await openStore(config(root), { schemas });
  setConfigForTests({ federation: { missingwaitms: 0 } });
  try {
    const g = await genesis(store, {
      roomId: '!send-restart:test',
      joinRule: 'public',
    });
    const { peer, deps, message } = await joinedPeer(store, g);
    const eventId = message.event_id!;
    // The process dies after acceptance: no in-memory owner ever acts.
    setRoomHooks({
      project: () => Promise.resolve(),
      register: () => Promise.resolve(),
      enroll: () => {},
      complete: () => new Promise<void>(() => {}),
    });
    let answer;
    try {
      answer = await guard(
        receiveTransaction(
          peer.name,
          'restart',
          transaction(peer.name, message),
          deps,
        ),
        'inbound /send waited for a publication owner',
      );
    } finally {
      installServerHooks();
    }
    assertEquals(answer, { status: 200, body: { pdus: { [eventId]: {} } } });
    const room = await openRoom(store, g.roomId);
    const target = await room.tx((tx) => tx.completion.capture());
    assert(
      (await room.tx((tx) => tx.completion.state())).completedThrough <
        target.through,
    );
    assertEquals(await feedRows(store, g.roomId, eventId), []);
    await store.close();
    store = await openStore(config(root), { schemas });
    const reopened = await openRoom(store, g.roomId);
    assert(
      (await reopened.tx((tx) => tx.completion.state())).completedThrough >=
        target.through,
    );
    assertEquals(await feedRows(store, g.roomId, eventId), [{
      event: eventId,
    }]);
    assertEquals(
      await receiveTransaction(
        peer.name,
        'restart',
        transaction(peer.name, message),
        { ...deps, store },
      ),
      answer,
    );
    assertEquals(await feedRows(store, g.roomId, eventId), [{
      event: eventId,
    }]);
  } finally {
    setConfigForTests({ federation: { missingwaitms: 750 } });
    await store.close();
    await Deno.remove(root, { recursive: true });
  }
});
