// tests/federation-transactions.test.ts — inbound transactions at the
// function (routing is stage 5): origin mismatch 403; >50 PDUs 400; the
// replay cache; per-PDU outcomes (accepted {}, unknown room, refused
// error, rejected {}); in-order processing of a fork; EDUs — typing,
// receipt, presence for the origin's users (a wrong-domain user is
// ignored; an unknown type is ignored); unknown prev → stored ungrounded
// ({}) and the ungroundedmillihours = 0 drop ({ error }). (doltgres
// tests/federation-send.test.ts, restored at the engine functions; the
// middleware's backoff reset is the sender's contact hook, covered in
// federation-sender.test.ts.)
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { eduQueues, type EduState, eduState } from '#engine/federation/edus.ts';
import { receiveTransaction } from '#engine/federation/transactions.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { RemoteDeps } from '#engine/room/deps.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { type Genesis, genesis } from './fixtures/genesis.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
  type RemoteServer,
} from './fixtures/remote.ts';

installServerHooks();

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
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

type Setup = {
  g: Genesis;
  srv: RemoteServer;
  user: string;
  tip: string;
  deps: Omit<Parameters<typeof receiveTransaction>[3], 'store' | 'edus'>;
  edus: EduState;
};

async function remoteSetup(store: Store): Promise<Setup> {
  const g = await genesis(store, {
    roomId: '!fed-send:test',
    joinRule: 'public',
  });
  const srv = await makeRemoteServer('remote.test');
  const user = '@rudy:remote.test';
  const join = await remoteEvent(g.roomId, srv, '11', {
    type: 'm.room.member',
    sender: user,
    state_key: user,
    content: { membership: 'join' },
    prev_events: [g.tipId],
    auth_events: [g.createId],
    origin_server_ts: 100,
  });
  const { fetcher } = fakeFetcher({});
  const deps: RemoteDeps = {
    keys: fakeKeyResolver(srv),
    fetcher,
    self: g.signer.serverName,
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
  };
  const outcomes = await ingestRemote(g.room, [join], srv.name, deps);
  assertEquals(outcomes[0].outcome, 'accepted');
  return {
    g,
    srv,
    user,
    tip: String(join.event_id),
    deps: { keys: deps.keys, fetcher, self: deps.self },
    edus: eduState(await store.server(), g.signer.serverName),
  };
}

async function sendTxn(
  s: Setup,
  store: Store,
  txnId: string,
  body: Record<string, unknown>,
  origin = 'remote.test',
): Promise<{ status: number; body: Record<string, unknown> }> {
  return await receiveTransaction(origin, txnId, body, {
    store,
    keys: s.deps.keys,
    fetcher: s.deps.fetcher,
    self: s.deps.self,
    edus: s.edus,
  });
}

async function msg(
  s: Setup,
  body: string,
  prev: string[],
  opts: { sender?: string } = {},
): Promise<Pdu> {
  return await remoteEvent(s.g.roomId, s.srv, '11', {
    type: 'm.room.message',
    sender: opts.sender !== undefined ? opts.sender : s.user,
    content: { msgtype: 'm.text', body },
    prev_events: prev,
    auth_events: [s.g.createId],
  });
}

Deno.test('send: origin mismatch 403, >50 PDUs 400, replay returns the stored answer', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store);
    // origin mismatch
    try {
      await sendTxn(s, store, 't-origin', {
        origin: 'other.test',
        origin_server_ts: Date.now(),
        pdus: [],
      });
      throw new Error('expected a 403');
    } catch (e) {
      assertEquals((e as MatrixError).status, 403);
      assertEquals((e as MatrixError).errcode, 'M_FORBIDDEN');
    }
    // >50 PDUs
    const many = [];
    for (let i = 0; i < 51; i++) many.push({ type: 'm.room.message' });
    try {
      await sendTxn(s, store, 't-many', {
        origin: 'remote.test',
        origin_server_ts: Date.now(),
        pdus: many,
      });
      throw new Error('expected a 400');
    } catch (e) {
      assertEquals((e as MatrixError).status, 400);
      assertEquals((e as MatrixError).errcode, 'M_TOO_LARGE');
    }
    // replay: a valid transaction, then the same id again with a
    // DIFFERENT body — the stored answer comes back
    const event = await msg(s, 'replay me', [s.tip]);
    const first = await sendTxn(s, store, 't-replay', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [event],
    });
    assertEquals(first.status, 200);
    assertEquals(first.body.pdus, { [String(event.event_id)]: {} });
    const second = await sendTxn(s, store, 't-replay', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [],
    });
    assertEquals(second.status, 200);
    assertEquals(second.body, first.body);
  });
});

Deno.test('send: per-PDU outcomes — accepted {}, unknown room, refused error, rejected {}', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store);
    const good = await msg(s, 'good', [s.tip]);
    const unknownRoom = await remoteEvent('!fed-send-other:test', s.srv, '11', {
      type: 'm.room.message',
      sender: s.user,
      content: { msgtype: 'm.text', body: 'nowhere' },
      prev_events: ['$madeup'],
      auth_events: ['$madeupcreate'],
    });
    const badSig = await msg(s, 'forged sig', [s.tip]);
    (badSig.signatures as Record<string, Record<string, string>>)[
      'remote.test'
    ]['ed25519:1'] = 'AAAA';
    const nonMember = await msg(s, 'not a member', [s.tip], {
      sender: '@stranger:remote.test', // never joined — rule 5 rejects
    });
    const res = await sendTxn(s, store, 't-outcomes', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [good, unknownRoom, badSig, nonMember],
    });
    assertEquals(res.status, 200);
    const pdus = res.body.pdus as Record<string, Record<string, unknown>>;
    assertEquals(pdus[String(good.event_id)], {});
    assert(
      String(pdus[String(unknownRoom.event_id)]?.error).includes(
        'unknown room',
      ),
      JSON.stringify(pdus),
    );
    assert(
      pdus[String(badSig.event_id)]?.error !== undefined,
      'the forged signature carries an error',
    );
    assertEquals(
      pdus[String(nonMember.event_id)],
      {},
      'rejection is not an error',
    );
    // the accepted one is really in the room now (indexed, sequenced)
    const server = await store.server();
    const rows = await server.query(
      'SELECT standing, seq FROM event_index WHERE event = ?',
      [String(good.event_id)],
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].standing, 'accepted');
    assert(typeof rows[0].seq === 'number', 'live — it has a feed seq');
  });
});

Deno.test('send: in-order processing of a fork', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store);
    const e1 = await msg(s, 'fork e1', [s.tip]);
    const e2 = await msg(s, 'fork e2', [String(e1.event_id)]);
    const res = await sendTxn(s, store, 't-fork', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [e1, e2],
    });
    assertEquals(res.status, 200);
    assertEquals(res.body.pdus, {
      [String(e1.event_id)]: {},
      [String(e2.event_id)]: {},
    });
  });
});

Deno.test('send: EDUs — typing, receipt, presence for the origin’s users; wrong domain ignored; unknown type ignored', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store);
    const event = await msg(s, 'receipt target', [s.tip]);
    const res = await sendTxn(s, store, 't-edus', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [event],
      edus: [
        {
          edu_type: 'm.typing',
          content: {
            room_id: s.g.roomId,
            user_id: s.user,
            typing: true,
          },
        },
        // wrong domain — ignored
        {
          edu_type: 'm.typing',
          content: {
            room_id: s.g.roomId,
            user_id: '@nope:other.test',
            typing: true,
          },
        },
        {
          edu_type: 'm.receipt',
          content: {
            [s.g.roomId]: {
              'm.read': {
                [s.user]: {
                  event_ids: [String(event.event_id)],
                  data: { ts: 1234567890 },
                },
              },
            },
          },
        },
        {
          edu_type: 'm.presence',
          content: {
            push: [{
              user_id: s.user,
              presence: 'online',
              status_msg: 'on the wire',
              last_active_ago: 1000,
              currently_active: true,
            }],
          },
        },
        {
          edu_type: 'm.device_list_update',
          content: { user_id: s.user },
        },
        { edu_type: 'm.something.unknown', content: {} },
      ],
    });
    assertEquals(res.status, 200);
    // typing lands for the origin's user only
    const typing = s.edus.typingOf(s.g.roomId);
    assert(typing.userIds.includes(s.user), JSON.stringify(typing));
    assert(!typing.userIds.some((u) => u.endsWith(':other.test')));
    // the receipt is held
    const receipts = s.edus.receiptsIn(s.g.roomId);
    assertEquals(receipts.length, 1);
    assertEquals(receipts[0].userId, s.user);
    assertEquals(receipts[0].eventId, String(event.event_id));
    assertEquals(receipts[0].ts, 1234567890);
    // presence
    const presence = s.edus.presenceOf(s.user);
    assert(presence !== null);
    assertEquals(presence.presence, 'online');
    assertEquals(presence.status_msg, 'on the wire');
  });
});

Deno.test('edus: queueing coalesces per key, merges on drain, and never queues remote users', () => {
  const isLocal = (userId: string) => userId.endsWith(':test');
  const woken: string[] = [];
  const queues = eduQueues(isLocal, (d) => woken.push(d));
  // two typing changes from dev coalesce to one EDU; a remote user's
  // typing never queues
  queues.queueTyping('remote.test', '!r:test', '@dev:test', true, 1);
  queues.queueTyping('remote.test', '!r:test', '@rudy:remote.test', true, 2);
  queues.queueTyping('remote.test', '!r:test', '@dev:test', false, 3);
  // a stale seq never overwrites a fresh change
  queues.queueTyping('remote.test', '!r:test', '@dev:test', true, 2);
  queues.queueReceipt('remote.test', {
    roomId: '!r:test',
    userId: '@dev:test',
    eventId: '$e1',
    ts: 7,
    threadId: null,
  }, 4);
  queues.queuePresence('remote.test', {
    user_id: '@dev:test',
    presence: 'online',
    status_msg: null,
    last_active_ago: 0,
    currently_active: true,
  }, 5);
  queues.queuePresence('remote.test', {
    user_id: '@bob:elsewhere.test',
    presence: 'online',
    status_msg: null,
    last_active_ago: 0,
    currently_active: true,
  }, 6);
  // dev's two fresh typing changes, the receipt and the presence each
  // wake; the remote user and the stale seq never do
  assertEquals(woken, [
    'remote.test',
    'remote.test',
    'remote.test',
    'remote.test',
  ]);
  const drained = queues.drain('remote.test', 100);
  const typing = drained.filter((e) => e.edu_type === 'm.typing');
  assertEquals(typing.length, 1);
  assertEquals(
    (typing[0].content as Record<string, unknown>).typing,
    false,
    'the latest state wins',
  );
  const receipt = drained.find((e) => e.edu_type === 'm.receipt');
  assert(receipt !== undefined);
  const receiptContent = receipt.content as Record<
    string,
    Record<string, Record<string, { event_ids: string[] }>>
  >;
  assertEquals(receiptContent['!r:test']['m.read']['@dev:test'].event_ids, [
    '$e1',
  ]);
  const presence = drained.find((e) => e.edu_type === 'm.presence');
  assert(presence !== undefined);
  const push = (presence.content as { push: { user_id: string }[] }).push;
  assertEquals(push.length, 1);
  assertEquals(push[0].user_id, '@dev:test');
  // the drain emptied the queues
  assertEquals(queues.drain('remote.test', 100), []);
});

Deno.test('send: unknown prev → stored ungrounded ({}); ungroundedmillihours = 0 drops ({ error })', async () => {
  await withStore(async (store) => {
    const s = await remoteSetup(store);
    const orphaned = await msg(s, 'no parents', [
      '$madeupprev1',
      '$madeupprev2',
    ]);
    const res = await sendTxn(s, store, 't-ungrounded', {
      origin: 'remote.test',
      origin_server_ts: Date.now(),
      pdus: [orphaned],
    });
    assertEquals(res.status, 200);
    assertEquals(res.body.pdus, { [String(orphaned.event_id)]: {} });
    // the placeholder: stored pending, waits on the made-up prevs
    const status = await s.g.room.tx(async (tx) => {
      const row = await tx.events.getStatus(String(orphaned.event_id));
      const waits = await tx.waits.of(String(orphaned.event_id));
      return { row, waits };
    });
    assert(status.row !== null, 'placeholder row exists');
    assertEquals(status.row.grounding, 'pending');
    assertEquals(
      status.waits.map((w) => w.missing).sort(),
      ['$madeupprev1', '$madeupprev2'],
    );
    // a placeholder is never news (no feed seq)
    const server = await store.server();
    const indexed = await server.query(
      'SELECT seq, grounding FROM event_index WHERE event = ?',
      [String(orphaned.event_id)],
    );
    assertEquals(indexed.length, 1);
    assertEquals(indexed[0].seq, null);
    // ungroundedmillihours = 0 → dropped with an { error }
    setConfigForTests({ federation: { ungroundedmillihours: 0 } });
    try {
      const other = await msg(s, 'also no parents', ['$alsomadeup']);
      const res2 = await sendTxn(s, store, 't-dropped', {
        origin: 'remote.test',
        origin_server_ts: Date.now(),
        pdus: [other],
      });
      assertEquals(res2.status, 200);
      const pdus = res2.body.pdus as Record<string, Record<string, unknown>>;
      assert(
        pdus[String(other.event_id)]?.error !== undefined,
        JSON.stringify(pdus),
      );
      const gone = await s.g.room.tx(async (tx) =>
        await tx.events.get(String(other.event_id))
      );
      assertEquals(gone, null, 'dropped, not stored');
    } finally {
      setConfigForTests({ federation: { ungroundedmillihours: 256000 } });
    }
  });
});
