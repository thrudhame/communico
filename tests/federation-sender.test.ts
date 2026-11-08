// tests/federation-sender.test.ts — the outbound delivery loop on the 4b
// outbox: rows visible after the room write (the projection), delivery
// within ~1 s, wire form, sent marks; the derived frozen batch (retry =
// same txn id/ts/PDUs/EDUs; a restart sends PDUs only); every non-2xx
// retried on the millihour ladder; a 4xx writes the 'refused' entry; the
// expiry sweep with batch retirement; the contact hook resets the ladder
// and wakes the queue; a block stops the loop (rows for the operator);
// retry/prune doors; intents on their own path (stub provider); an
// EDU-only change delivers within 1 s; batches cap at 50 PDUs. Live
// store + the fake remote over real TLS (fixture CA). (doltgres
// tests/federation-outbox.test.ts, restored at the engine functions —
// endpoints are stage 5.)
import { assert, assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import {
  listOutbox,
  peerStatus,
  pruneDestination,
  retryDestination,
  type Sender,
  startSender,
} from '#engine/federation/sender.ts';
import { addBlock, removeBlock } from '#engine/federation/peers.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { ingestRemote } from '#engine/room/remote.ts';
import type { Room } from '#engine/room/index.ts';
import { roomSchema } from '#engine/room/index.ts';
import type { Signer } from '#engine/room/signer.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import { openStore, type Store } from '#engine/store/index.ts';
import { type Genesis, genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  remoteEvent,
} from './fixtures/remote.ts';
import { testRemoteServer } from './fixtures/signer.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
} from '#engine/signing-primitives.js';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';

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

type SendCall = {
  txnId: string;
  origin_server_ts: number;
  pdus: Record<string, unknown>[];
  edus: { edu_type: string; content: unknown }[];
};

type Setup = {
  g: Genesis;
  fake: FakeServer;
  dest: string;
  sends: SendCall[];
  steer: { status: number; body: unknown };
  sender: Sender;
  sentAll: () => Promise<void>;
};

async function ourDoc(name: string): Promise<Record<string, unknown>> {
  const us = await testRemoteServer(name);
  return {
    server_name: name,
    verify_keys: {
      [us.keyId]: {
        key: b64encodeStd(await exportPublicKeyRaw(us.kp.publicKey)),
      },
    },
    old_verify_keys: {},
    valid_until_ts: Date.now() + 86400_000,
    signatures: {},
  };
}

async function waitFor(
  what: () => Promise<boolean> | boolean,
  ms = 15000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await what()) return;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function withSetup<T>(
  store: Store,
  fn: (s: Setup) => Promise<T>,
  opts: {
    drainEdus?: (destination: string, limit: number) => {
      edu_type: string;
      content: Record<string, unknown>;
    }[];
  } = {},
): Promise<T> {
  setConfigForTests({
    federation: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      backoffstartmillihours: 1,
    },
  });
  resetCaCertsForTests();
  const sends: SendCall[] = [];
  const steer = { status: 200, body: { pdus: {} } };
  const g = await genesis(store, {
    roomId: '!fed-sender:test',
    joinRule: 'public',
  });
  const doc = await ourDoc(g.signer.serverName);
  const fake = await startFakeServer({
    ourKeyDoc: () => Promise.resolve(doc),
    handlers: (req) => {
      const m = /^\/_matrix\/federation\/v1\/send\/(.+)$/.exec(
        req.url.pathname,
      );
      if (!m) return null;
      const body = req.json() as {
        origin_server_ts: number;
        pdus?: Record<string, unknown>[];
        edus?: { edu_type: string; content: unknown }[];
      };
      sends.push({
        txnId: decodeURIComponent(m[1]),
        origin_server_ts: body.origin_server_ts,
        pdus: body.pdus ?? [],
        edus: body.edus ?? [],
      });
      return Response.json(steer.body, { status: steer.status });
    },
  });
  const dest = fake.name;
  // a joined remote member — its domain is the delivery target. Joined
  // through the REMOTE pipeline (signed by the fake): a remote event
  // emits no delivery intent, so only the test's own messages queue.
  const remoteMember = { name: fake.name, keyId: fake.keyId, kp: fake.kp };
  const join = await remoteEvent(g.roomId, remoteMember, '11', {
    type: 'm.room.member',
    sender: `@bob:${dest}`,
    state_key: `@bob:${dest}`,
    content: { membership: 'join' },
    prev_events: [g.tipId],
    auth_events: await authAt(g.room, {
      type: 'm.room.member',
      sender: `@bob:${dest}`,
      state_key: `@bob:${dest}`,
      content: { membership: 'join' },
    }, g.tipId),
    origin_server_ts: 100,
  });
  const joined = await ingestRemote(g.room, [join], dest, {
    keys: fakeKeyResolver(remoteMember),
    fetcher: fakeFetcher({}).fetcher,
    self: g.signer.serverName,
    limits: { waitMs: 0, limit: 10, budgetMs: 8000 },
    ungroundedMs: 3_600_000,
  });
  assertEquals(joined[0].outcome, 'accepted');
  const sender = startSender({
    store,
    signer: g.signer,
    drainEdus: opts.drainEdus,
  });
  const sentAll = async () => {
    await waitFor(async () =>
      (await listOutbox(await store.server(), dest))
        .every((r) => r.state !== 'pending')
    );
  };
  try {
    return await fn({ g, fake, dest, sends, steer, sender, sentAll });
  } finally {
    await sender.stop();
    await fake.close();
    setConfigForTests({
      federation: { cacerts: [], backoffstartmillihours: 125 },
    });
    resetCaCertsForTests();
  }
}

async function devSays(
  room: Room,
  signer: Signer,
  body: string,
): Promise<string> {
  const res = await sendLocal(room, {
    type: 'm.room.message',
    sender: '@dev:test',
    content: { msgtype: 'm.text', body },
    origin_server_ts: Date.now(),
  }, signer);
  return res.eventId;
}

Deno.test('sender: rows visible after the room write; delivery; wire form; sent marks + clean ladder', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ g, dest, sends }) => {
      const server = await store.server();
      const eventId = await devSays(g.room, g.signer, 'hello federation');
      // the row is visible immediately (the projection ran inside sendLocal)
      const rows = await listOutbox(server, dest);
      assertEquals(rows.length, 1);
      assertEquals(rows[0].event, eventId);
      assertEquals(rows[0].state, 'pending');
      // delivered within ~1 s of the projection wake
      await waitFor(() => sends.length === 1, 3000);
      // wire form: no event_id, no unsigned
      assertEquals(sends[0].pdus.length, 1);
      assert(
        !('event_id' in sends[0].pdus[0]),
        JSON.stringify(sends[0].pdus[0]),
      );
      assert(!('unsigned' in sends[0].pdus[0]));
      assertEquals(
        (sends[0].pdus[0].content as Record<string, unknown>).body,
        'hello federation',
      );
      // 2xx → rows sent, ladder clean
      await waitFor(
        async () => (await peerStatus(server, dest)).lastSuccessMs !== null,
        3000,
      );
      const st = await peerStatus(server, dest);
      assertEquals(st.failures, 0);
      assertEquals((await listOutbox(server, dest))[0].state, 'sent');
    });
  });
});

Deno.test('sender: frozen retry — same txn id, ts, PDUs and EDUs; PDUs only after a restart', async () => {
  await withStore(async (store) => {
    // a draining stub: the real queues land in edus.ts (c3); the
    // drain-once shape is what the sender's frozen cache relies on
    const queue: { edu_type: string; content: Record<string, unknown> }[] = [
      {
        edu_type: 'm.typing',
        content: {
          room_id: '!fed-sender:test',
          user_id: '@dev:test',
          typing: true,
        },
      },
    ];
    const drain = () => queue.splice(0, queue.length);
    await withSetup(store, async ({ g, dest, sends, steer, sender }) => {
      const server = await store.server();
      steer.status = 500;
      await devSays(g.room, g.signer, 'retry me');
      await waitFor(() => sends.some((s) => s.pdus.length > 0), 3000);
      const first = sends.find((s) => s.pdus.length > 0)!;
      // the retry (after the tiny ladder step) resends the SAME transaction
      await waitFor(
        () => sends.filter((s) => s.txnId === first.txnId).length >= 2,
        8000,
      );
      const second = sends.filter((s) => s.txnId === first.txnId)[1];
      assertEquals(second.origin_server_ts, first.origin_server_ts);
      assertEquals(second.pdus, first.pdus);
      assertEquals(second.edus, first.edus);
      assertEquals(second.edus.length, 1, 'the frozen EDU rides again');
      // a restart: the derived batch's EDUs were never persisted — PDUs only
      await sender.stop();
      const restarted = startSender({
        store,
        signer: g.signer,
        drainEdus: drain,
      });
      try {
        await waitFor(
          () => sends.filter((s) => s.txnId === first.txnId).length >= 3,
          12000,
        );
        const third = sends.filter((s) => s.txnId === first.txnId)[2];
        assertEquals(third.pdus, first.pdus);
        assertEquals(third.origin_server_ts, first.origin_server_ts);
        assertEquals(third.edus, []);
        // success now: rows sent
        steer.status = 200;
        await waitFor(
          async () => (await peerStatus(server, dest)).lastSuccessMs !== null,
          15000,
        );
        assertEquals(
          (await listOutbox(server, dest)).filter((r) => r.state === 'pending')
            .length,
          0,
        );
        const st = await peerStatus(server, dest);
        assertEquals(st.failures, 0);
        assert(st.failuresTotal >= 2, JSON.stringify(st));
        assert(st.attemptsTotal >= 3);
      } finally {
        await restarted.stop();
      }
    }, { drainEdus: drain });
  });
});

Deno.test('sender: a 4xx refusal is retried like a 5xx and writes the refused entry', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ g, dest, sends, steer }) => {
      const server = await store.server();
      steer.status = 403;
      steer.body = { errcode: 'M_FORBIDDEN', error: 'no' };
      await devSays(g.room, g.signer, 'refused');
      await waitFor(() => sends.length >= 2, 8000); // retried
      const rows = await listOutbox(server, dest);
      assertEquals(rows.length, 1, 'rows kept on a refusal (ruling E)');
      assertEquals(rows[0].state, 'pending');
      const pending = await server.query(
        "SELECT count, detail FROM federation_pending WHERE name = ? AND kind = 'refused'",
        [dest],
      );
      assert(pending.length > 0, 'the refused pending entry exists');
      const detail = JSON.parse(String(pending[0].detail)) as {
        last: { code: number; errcode: string; txnId: string };
      };
      assertEquals(detail.last.code, 403);
      assertEquals(detail.last.errcode, 'M_FORBIDDEN');
      assert(
        typeof detail.last.txnId === 'string',
        'the refusal names its txn',
      );
      steer.status = 200;
      steer.body = { pdus: {} };
    });
  });
});

Deno.test('sender: expiry sweep marks lapsed rows failed and records them; the fresh batch is a new transaction', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ g, dest, sends, steer, sender }) => {
      const server = await store.server();
      steer.status = 500;
      await devSays(g.room, g.signer, 'will expire');
      await waitFor(() => sends.length >= 1, 3000);
      const firstTxn = sends[0].txnId;
      // age the row past its lifespan directly, with the loop stopped
      // (no write-write race with the retrying sender); the restarted
      // sender's resume scan runs the sweep
      await sender.stop();
      await server.execute(
        "UPDATE outbox SET added_ms = ? WHERE destination = ? AND state = 'pending'",
        [Date.now() - 257000 * 3_600, dest],
      );
      const restarted = startSender({ store, signer: g.signer });
      try {
        await waitFor(
          async () =>
            (await listOutbox(server, dest)).every((r) => r.state === 'failed'),
          12000,
        );
        const pending = await server.query(
          "SELECT detail FROM federation_pending WHERE name = ? AND kind = 'refused'",
          [dest],
        );
        assert(
          pending.length > 0 && String(pending[0].detail).includes('expired'),
          JSON.stringify(pending),
        );
        // a fresh event is a NEW transaction (the old batch retired)
        steer.status = 500;
        await devSays(g.room, g.signer, 'fresh batch');
        await waitFor(() => sends.some((s) => s.txnId !== firstTxn), 12000);
        steer.status = 200;
        steer.body = { pdus: {} };
      } finally {
        await restarted.stop();
      }
    });
  });
});

Deno.test('sender: the contact hook resets the ladder and wakes the queue', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ g, dest, steer, sender }) => {
      const server = await store.server();
      steer.status = 500;
      await devSays(g.room, g.signer, 'backed off');
      // the failure lands a tick after the request — wait on IT
      await waitFor(
        async () => (await peerStatus(server, dest)).failures >= 1,
        5000,
      );
      const st1 = await peerStatus(server, dest);
      assert(st1.unreachableSinceMs !== null);
      // inbound contact: ladder to zero, the queue wakes
      steer.status = 200;
      steer.body = { pdus: {} };
      sender.contactHook()(dest);
      await waitFor(async () => {
        const st = await peerStatus(server, dest);
        return st.failures === 0 && st.lastInboundMs !== null;
      }, 3000);
      await waitFor(
        async () =>
          (await listOutbox(server, dest)).every((r) => r.state === 'sent'),
        8000,
      );
    });
  });
});

Deno.test('sender: a block stops the loop, rows left for the operator; prune + retry are the doors', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ g, dest, sends, steer, sender }) => {
      const server = await store.server();
      steer.status = 500;
      await devSays(g.room, g.signer, 'blocked soon');
      await waitFor(() => sends.length >= 1, 3000);
      await addBlock(server, dest, 'test block');
      sender.wake(dest);
      const before = sends.length;
      await new Promise((r) => setTimeout(r, 400));
      assertEquals(
        sends.length,
        before,
        'a blocked destination is not dialled',
      );
      assertEquals(
        (await listOutbox(server, dest)).filter((r) => r.state === 'pending')
          .length,
        1,
        'rows left in place',
      );
      await removeBlock(server, dest);
      // retry refreshes the lifespan basis and re-queues
      const before2 = (await listOutbox(server, dest))[0].addedMs;
      await new Promise((r) => setTimeout(r, 10));
      await retryDestination(server, dest);
      const after = (await listOutbox(server, dest))[0].addedMs;
      assert(after > before2, `retry refreshes expiry: ${before2} -> ${after}`);
      steer.status = 200;
      steer.body = { pdus: {} };
      await waitFor(
        async () =>
          (await listOutbox(server, dest)).every((r) => r.state === 'sent'),
        8000,
      );
      // prune: the operator's delete door
      await devSays(g.room, g.signer, 'prune me');
      await waitFor(
        async () =>
          (await listOutbox(server, dest)).some((r) => r.state === 'pending'),
        3000,
      );
      const n = await pruneDestination(server, dest);
      assert(n >= 1);
      assertEquals((await listOutbox(server, dest)).length, 0);
    });
  });
});

Deno.test('sender: intents on their own path — one attempt per wake, the ladder counts failures', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ dest, sender }) => {
      const server = await store.server();
      const calls: string[] = [];
      const jobs = new Map<string, { runs: number; fail: boolean }>([
        ['job-1', { runs: 0, fail: true }],
        ['job-2', { runs: 0, fail: false }],
      ]);
      sender.setIntentProvider((_server, destination) => {
        for (const [id, job] of jobs) {
          if (job.runs === 0) {
            return Promise.resolve({
              id,
              run: () => {
                job.runs++;
                calls.push(`${destination}:${id}`);
                if (job.fail) throw new Error(`${id} down`);
                jobs.delete(id);
                return Promise.resolve();
              },
              failed: () => Promise.resolve(),
            });
          }
        }
        return Promise.resolve(null);
      });
      sender.wake(dest);
      await waitFor(() => calls.length >= 2, 8000);
      assertEquals(calls, [`${dest}:job-1`, `${dest}:job-2`]);
      // the failure counted the ladder
      const st = await peerStatus(server, dest);
      assert(st.failuresTotal >= 1, JSON.stringify(st));
      sender.setIntentProvider(null);
    });
  });
});

Deno.test('sender: an EDU-only change delivers within 1 s of its wake, no PDUs, fresh txn ids', async () => {
  await withStore(async (store) => {
    const queue: { edu_type: string; content: Record<string, unknown> }[] = [];
    const drain = (_destination: string, _limit: number) =>
      queue.splice(0, queue.length);
    await withSetup(store, async ({ dest, sends, sender }) => {
      queue.push({
        edu_type: 'm.typing',
        content: {
          room_id: '!fed-sender:test',
          user_id: '@dev:test',
          typing: true,
        },
      });
      // the queue's wake (edus.ts wires it in c3) is the sender's public one
      sender.wake(dest);
      await waitFor(() => sends.length >= 1, 1000);
      assertEquals(sends[0].pdus.length, 0, 'no PDUs in an EDU-only txn');
      assertEquals(sends[0].edus.length, 1);
      assertEquals(sends[0].edus[0].edu_type, 'm.typing');
      // a second EDU rides a FRESH transaction id
      queue.push({
        edu_type: 'm.typing',
        content: {
          room_id: '!fed-sender:test',
          user_id: '@dev:test',
          typing: false,
        },
      });
      sender.wake(dest);
      await waitFor(() => sends.length >= 2, 1000);
      assert(sends[1].txnId !== sends[0].txnId, 'EDU-only txns get fresh ids');
    }, { drainEdus: drain });
  });
});

Deno.test('sender: batches cap at 50 PDUs per transaction', async () => {
  await withStore(async (store) => {
    await withSetup(store, async ({ g, dest, sends }) => {
      const server = await store.server();
      for (let i = 0; i < 60; i++) await devSays(g.room, g.signer, `m${i}`);
      await waitFor(async () => {
        const total = sends.reduce((n, s) => n + s.pdus.length, 0);
        const pendingLeft = (await listOutbox(server, dest))
          .filter((r) => r.state === 'pending').length;
        return total >= 60 && pendingLeft === 0;
      }, 30000);
      for (const s of sends) {
        assert(s.pdus.length <= 50, `batch of ${s.pdus.length}`);
      }
    });
  });
});
