// tests/federation-outbox.test.ts — M5b commit 3: the durable outbox and
// the sender loop. Rows written in the same write as the index row;
// destinations per §3.2; frozen-batch retry (same txnId/ts/PDUs/EDUs;
// PDUs only after a restart); every non-2xx retried on the millihour
// ladder; a 4xx writes the 'refused' pending entry; expiry sweep with
// batch retirement; notifyPeerAlive resets; isBlocked stops the loop;
// the tool's list/retry/prune; intent rows on their own path with a stub
// performer; EDU coalescing + the local-only rule. Live doltgres; the
// fake remote server receives /send over real TLS.
import { assert, assertEquals } from '@std/assert';
import { serverDb, withDb } from '#engine/db.ts';
import { setConfigForTests } from '#engine/config.ts';
import { createRoom } from '#engine/room.ts';
import { author, ingestEvent } from '#engine/ingest.ts';
import { setTyping } from '#engine/typing.ts';
import { setReceipt } from '#engine/receipts.ts';
import { addBlock, removeBlock } from '#engine/federation/peers.ts';
import { acquireKeyDocWith, type KeysDeps } from '#engine/federation/keys.ts';
import {
  resetCaCertsForTests,
  wireFederationTransport,
} from '#engine/federation/client.ts';
import {
  listOutbox,
  notifyPeerAlive,
  peerStatus,
  pruneDestination,
  retryDestination,
} from '#engine/federation/outbox.ts';
import {
  registerIntentPerformer,
  resetSenderForTests,
  startSender,
  wakeDestination,
} from '#engine/federation/sender.ts';
import { resetEdusForTests } from '#engine/federation/edus.ts';
import { type FakeServer, startFakeServer } from './federation/fake-server.ts';
import { createIdOf } from './federation/room-events.ts';
import { contentHashOf } from '#engine/signing-primitives.js';
import { eventIdFor } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';
import {
  latestExtremityEventId,
  resetFederationTables,
  resetRoom,
} from './util.ts';
import { pathfinder } from '@pathfinder/pathfinder';

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const ROOM = '!fed-outbox:localhost';

async function inProcessKeyDoc(): Promise<unknown> {
  const res = await matrix(new Request('http://x/_matrix/key/v2/server'));
  return await res.json();
}

type SendCall = {
  txnId: string;
  origin_server_ts: number;
  pdus: Record<string, unknown>[];
  edus: { edu_type: string; content: unknown }[];
};

type Setup = {
  fake: FakeServer;
  dest: string;
  sends: SendCall[];
  steer: { status: number; body: unknown };
  sentAll: () => Promise<void>;
  close: () => Promise<void>;
};

async function withSetup<T>(
  fn: (s: Setup) => Promise<T>,
  opts: { backoffMh?: number } = {},
): Promise<T> {
  await resetFederationTables();
  await resetRoom(ROOM);
  setConfigForTests({
    federation: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      backoffstartmillihours: opts.backoffMh ?? 1,
    },
  });
  resetCaCertsForTests();
  wireFederationTransport();
  const sends: SendCall[] = [];
  const steer = { status: 200, body: { pdus: {} } };
  const fake = await startFakeServer({
    ourKeyDoc: inProcessKeyDoc,
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
  // the fake's own document, seeded into the remembered-keys tables
  await acquireKeyDocWith(dest, 0, {
    directGet: () => fake.keyDoc(),
    witnessQuery: () => Promise.reject(new Error('no witnesses')),
    listWitnesses: () => Promise.resolve([]),
  } as KeysDeps);
  // the room with the fake's user joined (its domain = the delivery target)
  await createRoom(ROOM, '@dev:localhost', {
    roomVersion: '11',
    preset: 'public_chat',
  });
  const tip = await latestExtremityEventId(ROOM);
  // the join is signed by the fake (its key is on its domain); the
  // minimal member content makes its plain sign() the redacted form too
  const join: Pdu = {
    type: 'm.room.member',
    sender: `@rudy:${dest}`,
    room_id: ROOM,
    state_key: `@rudy:${dest}`,
    content: { membership: 'join' },
    prev_events: [tip],
    auth_events: [await createIdOf(ROOM)],
    depth: 99,
    origin_server_ts: Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  const { event_id: _a, signatures: _b, hashes: _c, ...forHash } =
    join as unknown as Record<string, unknown>;
  void _a, void _b, void _c;
  (join.hashes as { sha256: string }).sha256 = await contentHashOf(forHash);
  (join as unknown as Record<string, unknown>).event_id = await eventIdFor(
    join as unknown as Record<string, unknown>,
    '11',
  );
  await fake.sign(join as unknown as Record<string, unknown>);
  await ingestEvent(ROOM, join, {
    remote: { origin: dest, position: 'after' },
  });
  startSender();
  const sentAll = async () => {
    const deadline = Date.now() + 15000;
    for (;;) {
      const rows = await listOutbox(dest);
      if (rows.length === 0 && sends.length > 0) return;
      if (rows.length === 0) return;
      if (Date.now() > deadline) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    return await fn({
      fake,
      dest,
      sends,
      steer,
      sentAll,
      close: async () => {},
    });
  } finally {
    await fake.close();
    setConfigForTests({
      federation: { cacerts: [], backoffstartmillihours: 125 },
    });
    resetCaCertsForTests();
    resetEdusForTests();
    resetSenderForTests();
  }
}

async function devSays(body: string): Promise<string> {
  const pdu = await author(ROOM, {
    type: 'm.room.message',
    sender: '@dev:localhost',
    content: { msgtype: 'm.text', body },
  });
  await ingestEvent(ROOM, pdu);
  return String(pdu.event_id);
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

Deno.test('outbox: rows in the same write; delivery within 1 s; wire form; success deletes', async () => {
  await withSetup(async ({ fake, sends, dest }) => {
    const eventId = await devSays('hello federation');
    // the row is visible immediately (same write as the index row)
    const rows = await listOutbox(dest);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].eventId, eventId);
    assertEquals(rows[0].kind, 'event');
    // delivered within ~1s of the applied signal
    await waitFor(() => sends.length === 1, 3000);
    // wire form: no event_id, no unsigned
    assertEquals(sends[0].pdus.length, 1);
    assert(!('event_id' in sends[0].pdus[0]), JSON.stringify(sends[0].pdus[0]));
    assert(!('unsigned' in sends[0].pdus[0]));
    assertEquals(
      (sends[0].pdus[0].content as Record<string, unknown>).body,
      'hello federation',
    );
    // 2xx → rows deleted, ladder clean (the status write trails the
    // delete by a tick — wait on IT, not the rows)
    await waitFor(
      async () => (await peerStatus(dest)).lastSuccessMs !== null,
      3000,
    );
    const st = await peerStatus(dest);
    assertEquals(st.failures, 0);
    void fake;
  });
});

Deno.test('outbox: destinations = joined domains before the event ∪ leave target − us − origin', async () => {
  await withSetup(async ({ fake, sends: _s, dest }) => {
    // the remote member leaves (a remote on-behalf event is commit 7's;
    // here the local fan-out of a leave targets the leaver's server even
    // with no member left in the state before)
    const leave = await author(ROOM, {
      type: 'm.room.member',
      state_key: `@rudy:${dest}`,
      sender: '@dev:localhost',
      content: { membership: 'ban' },
    });
    await ingestEvent(ROOM, leave);
    await waitFor(async () => (await listOutbox(dest)).length === 0, 3000);
    const sent = fake.requests.filter((r) =>
      r.path.startsWith('/_matrix/federation/v1/send/')
    );
    assert(sent.length >= 1, 'leave fanned out to the banned server');
    void _s;
  });
});

Deno.test('outbox: frozen retry — same txnId, ts, PDUs and EDUs; PDUs only after a restart', async () => {
  await withSetup(async ({ sends, steer, dest }) => {
    steer.status = 500;
    // an EDU rides with the first attempt: dev types, then says
    setTyping(ROOM, '@dev:localhost', true);
    await devSays('retry me');
    await waitFor(() => sends.length >= 1, 3000);
    const first = sends[0];
    assertEquals(first.edus.length, 1);
    assertEquals(first.edus[0].edu_type, 'm.typing');
    // the retry (after the tiny ladder step) resends the SAME transaction
    await waitFor(() => sends.length >= 2, 8000);
    const second = sends[1];
    assertEquals(second.txnId, first.txnId);
    assertEquals(second.origin_server_ts, first.origin_server_ts);
    assertEquals(second.pdus, first.pdus);
    assertEquals(second.edus, first.edus);
    // a restart: the frozen batch's EDUs were never persisted — PDUs only
    resetSenderForTests();
    await waitFor(() => sends.length >= 3, 12000);
    const third = sends[2];
    assertEquals(third.txnId, first.txnId);
    assertEquals(third.pdus, first.pdus);
    assertEquals(third.edus, []);
    // success now: rows deleted
    steer.status = 200;
    await waitFor(
      async () => (await peerStatus(dest)).lastSuccessMs !== null,
      15000,
    );
    assertEquals((await listOutbox(dest)).length, 0);
    const st = await peerStatus(dest);
    assertEquals(st.failures, 0);
    assert(st.failuresTotal >= 2, JSON.stringify(st));
    assert(st.attemptsTotal >= 3);
  });
});

Deno.test('outbox: a 4xx refusal is retried like a 5xx and writes the refused entry', async () => {
  await withSetup(async ({ sends, steer, dest }) => {
    steer.status = 403;
    steer.body = { errcode: 'M_FORBIDDEN', error: 'no' };
    await devSays('refused');
    await waitFor(() => sends.length >= 2, 8000); // retried
    const rows = await listOutbox(dest);
    assertEquals(rows.length, 1, 'rows kept on a refusal (ruling E)');
    const pending = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        "SELECT count, detail FROM federation_pending WHERE name = $1 AND kind = 'refused';",
        [dest],
      );
      return r.rows.length ? r.rows[0] : null;
    });
    assert(pending !== null, 'the refused pending entry exists');
    const detail = JSON.parse(String(pending.detail)) as {
      last: { code: number; errcode: string };
    };
    assertEquals(detail.last.code, 403);
    assertEquals(detail.last.errcode, 'M_FORBIDDEN');
    steer.status = 200;
    steer.body = { pdus: {} };
  });
});

Deno.test('outbox: expiry sweep removes lapsed rows and records them; frozen-batch retirement mints a new txn', async () => {
  await withSetup(async ({ sends, steer, dest }) => {
    steer.status = 500;
    await devSays('will expire');
    await waitFor(() => sends.length >= 1, 3000);
    const firstTxn = sends[0].txnId;
    // age the row past its lifespan directly (the ladder keeps retrying;
    // the next loop's sweep sees it lapsed)
    await withDb(serverDb(), async (c) => {
      await c.query(
        'UPDATE federation_outbox SET expires_ms = $1 WHERE destination = $2;',
        [Date.now() - 1, dest],
      );
    });
    await waitFor(async () => (await listOutbox(dest)).length === 0, 12000);
    const pending = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        "SELECT detail FROM federation_pending WHERE name = $1 AND kind = 'refused';",
        [dest],
      );
      return r.rows.length ? String(r.rows[0].detail) : null;
    });
    assert(pending !== null && pending.includes('expired'), String(pending));
    // a fresh event mints a NEW txnId (the old batch was retired)
    steer.status = 500;
    await devSays('fresh batch');
    await waitFor(() => sends.some((s) => s.txnId !== firstTxn), 12000);
    steer.status = 200;
    steer.body = { pdus: {} };
  });
});

Deno.test('outbox: notifyPeerAlive resets the ladder and wakes the queue', async () => {
  await withSetup(async ({ sends, steer, dest }) => {
    steer.status = 500;
    await devSays('backed off');
    // the failure lands a tick after the request — wait on IT
    await waitFor(async () => (await peerStatus(dest)).failures >= 1, 5000);
    const st1 = await peerStatus(dest);
    assert(st1.unreachableSinceMs !== null);
    // inbound contact: ladder to zero, the queue wakes
    steer.status = 200;
    steer.body = { pdus: {} };
    await notifyPeerAlive(dest);
    wakeDestination(dest);
    const st2 = await peerStatus(dest);
    assertEquals(st2.failures, 0);
    assertEquals(st2.nextAttemptMs, 0);
    assert(st2.lastInboundMs !== null);
    await waitFor(async () => (await listOutbox(dest)).length === 0, 8000);
    void sends;
  });
});

Deno.test('outbox: a block stops the loop, rows left for the operator; prune + retry are the doors', async () => {
  await withSetup(async ({ sends, steer, dest }) => {
    steer.status = 500;
    await devSays('blocked soon');
    await waitFor(() => sends.length >= 1, 3000);
    await addBlock(dest, 'test block');
    wakeDestination(dest);
    const before = sends.length;
    await new Promise((r) => setTimeout(r, 400));
    assertEquals(sends.length, before, 'a blocked destination is not dialled');
    assertEquals((await listOutbox(dest)).length, 1, 'rows left in place');
    await removeBlock(dest);
    // retry refreshes expires_ms and re-queues
    const before2 = (await listOutbox(dest))[0].expiresMs;
    await new Promise((r) => setTimeout(r, 10));
    await retryDestination(dest);
    const after = (await listOutbox(dest))[0].expiresMs;
    assert(after > before2, `retry refreshes expiry: ${before2} -> ${after}`);
    steer.status = 200;
    steer.body = { pdus: {} };
    await waitFor(async () => (await listOutbox(dest)).length === 0, 8000);
    // prune: the operator's door
    await devSays('prune me');
    await waitFor(async () => (await listOutbox(dest)).length === 1, 3000);
    const n = await pruneDestination(dest);
    assertEquals(n, 1);
    assertEquals((await listOutbox(dest)).length, 0);
  });
});

Deno.test('outbox: intent rows on their own path — stub performer, candidate advance, admit per candidate', async () => {
  await withSetup(async ({ dest }) => {
    const calls: string[] = [];
    registerIntentPerformer('stub-dance', (d) => {
      calls.push(d);
      if (d === dest) throw new Error('first candidate down');
      return Promise.resolve();
    });
    await withDb(serverDb(), async (c) => {
      await c.query(
        `INSERT INTO federation_outbox (destination, room_id, kind, intent, added_ms, expires_ms)
         VALUES ($1, $2, 'intent', $3, $4, $5);`,
        [
          dest,
          ROOM,
          JSON.stringify({
            what: 'stub-dance',
            user_id: '@dev:localhost',
            candidates: [dest, 'second.test'],
          }),
          Date.now(),
          Date.now() + 60_000,
        ],
      );
    });
    wakeDestination(dest);
    // first candidate fails -> the row advances to the next candidate,
    // whose loop is woken and performs it
    await waitFor(() => calls.includes('second.test'), 8000);
    assertEquals(calls, [dest, 'second.test']);
    await waitFor(async () => (await listOutbox()).length === 0, 3000);
    // admit() ran per candidate: both landed on the roster (open mode)
    const roster = await withDb(serverDb(), async (c) => {
      const r = await c.query(
        'SELECT name FROM federation_peers ORDER BY added_ms;',
      );
      // deno-lint-ignore no-explicit-any
      return (r.rows as any[]).map((row) => String(row.name));
    });
    assert(roster.includes('second.test'), JSON.stringify(roster));
  });
});

Deno.test('outbox: EDU coalescing and the local-only rule', async () => {
  await withSetup(async ({ sends, dest }) => {
    // two typing changes from dev coalesce to one EDU; a remote user's
    // typing never queues
    setTyping(ROOM, '@dev:localhost', true);
    setTyping(ROOM, `@rudy:${dest}`, true);
    setTyping(ROOM, '@dev:localhost', false);
    await devSays('carry the edus');
    await waitFor(() => sends.length >= 1, 3000);
    const typing = sends[0].edus.filter((e) => e.edu_type === 'm.typing');
    assertEquals(typing.length, 1);
    assertEquals(
      (typing[0].content as Record<string, unknown>).user_id,
      '@dev:localhost',
    );
    assertEquals(
      (typing[0].content as Record<string, unknown>).typing,
      false,
      'the latest state wins',
    );
    // a receipt rides too, merged into one m.receipt
    const eventId = await devSays('read me');
    await setReceipt(ROOM, '@dev:localhost', 'm.read', eventId);
    await waitFor(() =>
      sends.some((s) => s.edus.some((e) => e.edu_type === 'm.receipt'))
    );
    const withReceipt = sends.find((s) =>
      s.edus.some((e) => e.edu_type === 'm.receipt')
    )!;
    const receipt = withReceipt.edus.find((e) => e.edu_type === 'm.receipt')!;
    const content = receipt.content as Record<
      string,
      Record<string, Record<string, { event_ids: string[] }>>
    >;
    assertEquals(content[ROOM]['m.read']['@dev:localhost'].event_ids, [
      eventId,
    ]);
    void dest;
  });
});

Deno.test('outbox: batches cap at 50 PDUs per transaction', async () => {
  await withSetup(async ({ sends, dest }) => {
    for (let i = 0; i < 60; i++) await devSays(`m${i}`);
    await waitFor(async () => {
      const total = sends.reduce((n, s) => n + s.pdus.length, 0);
      return total >= 60 && (await listOutbox(dest)).length === 0;
    }, 20000);
    for (const s of sends) {
      assert(s.pdus.length <= 50, `batch of ${s.pdus.length}`);
    }
  });
});
