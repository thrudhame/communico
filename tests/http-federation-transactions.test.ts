// doltgres federation-send HTTP outcomes. /sync rendering is assigned to
// 5a-3 in notes; these assertions observe producer persistence and EDU state.
import { assert, assertEquals } from '@std/assert';
import { startFederationServices, theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { toWire } from '#engine/federation/pdu.ts';
import { peerStatus } from '#engine/federation/sender.ts';
import type { Pdu } from '#engine/pdu.ts';
import { createRoom } from '#engine/room/create.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import { httpSuite } from './http-app.ts';
import {
  fedCaller,
  type Json,
  remoteServer,
  signTemplate,
} from './http-federation.ts';
import type { TestServer } from './federation/doc-helper.ts';

const { matrix, registerTestUser, test } = httpSuite(
  'HTTP federation transactions',
);
let remote: TestServer;
let fed: ReturnType<typeof fedCaller>;
let creator: string;
let token: string;
const enc = encodeURIComponent;
const prefix = '/_matrix/federation/v1/';
type Setup = {
  id: string;
  held: Room;
  tip: string;
  auth: string[];
  depth: number;
};
const user = () => '@rudy:' + remote.name;

async function setup(): Promise<Setup> {
  if (remote === undefined) {
    remote = await remoteServer('tx-http.test');
    fed = fedCaller(matrix, remote);
    const local = await registerTestUser('http-send-dev', 'pw');
    creator = local.user_id;
    token = local.access_token!;
  }
  const { roomId: id } = await createRoom(theApp().store, {
    creator,
    preset: 'public_chat',
  }, theApp().tenant.signer());
  const mk = await fed(
    'GET',
    prefix + 'make_join/' + enc(id) + '/' + enc(user()) + '?ver=11',
  );
  assertEquals(mk.status, 200);
  const join = await signTemplate(mk.body.event as Json, remote);
  const sent = await fed(
    'PUT',
    '/_matrix/federation/v2/send_join/' + enc(id) + '/' +
      enc(String(join.event_id)),
    toWire(join, '11'),
  );
  assertEquals(sent.status, 200);
  const leave = await fed(
    'GET',
    prefix + 'make_leave/' + enc(id) + '/' + enc(user()),
  );
  assertEquals(leave.status, 200);
  const template = leave.body.event as Json;
  return {
    id,
    held: await openRoom(theApp().store, id),
    tip: String(join.event_id),
    auth: template.auth_events as string[],
    depth: Number(template.depth),
  };
}

function message(s: Setup, body: string, extra: Json = {}) {
  return signTemplate({
    type: 'm.room.message',
    room_id: s.id,
    sender: user(),
    content: { msgtype: 'm.text', body },
    prev_events: [s.tip],
    auth_events: s.auth,
    depth: s.depth,
    ...extra,
  }, remote);
}

function send(id: string, pdus: Pdu[], edus: Json[] = []) {
  return fed('PUT', prefix + 'send/' + enc(id), {
    origin: remote.name,
    origin_server_ts: Date.now(),
    pdus: pdus.map((p) => toWire(p, '11')),
    edus,
  });
}

test('send: origin/caps and changed-body replay preserve the first per-PDU answer', async () => {
  const s = await setup();
  const bad = await fed('PUT', prefix + 'send/origin', {
    origin: 'wrong.test',
    pdus: [],
  });
  assertEquals([bad.status, bad.body.errcode], [403, 'M_FORBIDDEN']);
  for (
    const excess of [{ pdus: Array(51).fill({}) }, {
      pdus: [],
      edus: Array(101).fill({}),
    }]
  ) {
    const result = await fed('PUT', prefix + 'send/caps', {
      origin: remote.name,
      origin_server_ts: Date.now(),
      ...excess,
    });
    assertEquals([result.status, result.body.errcode], [400, 'M_TOO_LARGE']);
  }
  const pdu = await message(s, 'replay me');
  const first = await send('changed-replay', [pdu]);
  assertEquals(first, {
    status: 200,
    body: { pdus: { [String(pdu.event_id)]: {} } },
  });
  assertEquals(await send('changed-replay', []), first);
  assertEquals(
    (await s.held.tx((tx) => tx.events.getStatus(String(pdu.event_id))))
      ?.standing,
    'accepted',
  );
});

test('send: mixed accepted, unknown-room, dropped and rejected results reach the stored/client consumers', async () => {
  const s = await setup();
  const good = await message(s, 'HTTP accepted');
  const unknown = await message(s, 'unknown room', {
    room_id: '!unknown:' + remote.name,
    prev_events: ['$missing'],
    auth_events: ['$missing-create'],
  });
  const bad = await message(s, 'bad signature');
  bad.signatures![remote.name][remote.keyId] = 'AAAA';
  const create = await s.held.tx(async (tx) => {
    const refs = await tx.state.eventReadState(s.tip);
    assert(refs !== null);
    const id = await tx.state.groupKey(refs.after.group, 'm.room.create', '');
    assert(id !== null);
    return id;
  });
  const rejected = await message(s, 'HTTP rejected', {
    sender: '@stranger:' + remote.name,
    auth_events: [create],
  });
  const result = await send('mixed-results', [good, unknown, bad, rejected]);
  assertEquals(result.status, 200);
  const outcomes = result.body.pdus as Record<string, Json>;
  assertEquals(outcomes[String(good.event_id)], {});
  assert(
    String(outcomes[String(unknown.event_id)]?.error).includes('unknown room'),
  );
  assert(outcomes[String(bad.event_id)]?.error !== undefined);
  assertEquals(outcomes[String(rejected.event_id)], {});
  await s.held.tx(async (tx) => {
    assertEquals(
      (await tx.events.getStatus(String(good.event_id)))?.standing,
      'accepted',
    );
    assertEquals(
      (await tx.events.getStatus(String(rejected.event_id)))?.standing,
      'rejected',
    );
    assertEquals(await tx.events.get(String(bad.event_id)), null);
  });
  const response = await matrix(
    new Request(
      'http://x/_matrix/client/v3/rooms/' + enc(s.id) +
        '/messages?dir=b&limit=100',
      {
        headers: { authorization: 'Bearer ' + token },
      },
    ),
  );
  assertEquals(response.status, 200);
  const page = await response.json() as Json;
  const bodies = (page.chunk as Json[]).map((e) => (e.content as Json).body);
  assert(bodies.includes('HTTP accepted'));
  assert(!bodies.includes('HTTP rejected'));
  assert(!bodies.includes('bad signature'));
});

test('send: dependent PDUs in one transaction are processed in order', async () => {
  const s = await setup();
  const first = await message(s, 'first');
  const second = await message(s, 'second', {
    prev_events: [String(first.event_id)],
    depth: first.depth! + 1,
  });
  assertEquals(await send('ordered', [first, second]), {
    status: 200,
    body: {
      pdus: { [String(first.event_id)]: {}, [String(second.event_id)]: {} },
    },
  });
  await s.held.tx(async (tx) => {
    assertEquals(
      (await tx.events.getStatus(String(second.event_id)))?.grounding,
      'grounded',
    );
    assertEquals(await tx.events.prevsOf(String(second.event_id)), [
      String(first.event_id),
    ]);
  });
});

test('send: typing, receipt and presence EDUs update producer state only for the origin users', async () => {
  const s = await setup();
  const target = await message(s, 'receipt target');
  const foreign = '@nope:other.test';
  const result = await send('edus', [target], [
    {
      edu_type: 'm.typing',
      content: { room_id: s.id, user_id: user(), typing: true },
    },
    {
      edu_type: 'm.typing',
      content: { room_id: s.id, user_id: foreign, typing: true },
    },
    {
      edu_type: 'm.receipt',
      content: {
        [s.id]: {
          'm.read': {
            [user()]: {
              event_ids: [String(target.event_id)],
              data: { ts: 1234567890 },
            },
            [foreign]: {
              event_ids: [String(target.event_id)],
              data: { ts: 1 },
            },
          },
        },
      },
    },
    {
      edu_type: 'm.presence',
      content: {
        push: [
          {
            user_id: user(),
            presence: 'online',
            status_msg: 'on the wire',
            last_active_ago: 1000,
            currently_active: true,
          },
          { user_id: foreign, presence: 'online' },
        ],
      },
    },
    { edu_type: 'm.device_list_update', content: { user_id: user() } },
    { edu_type: 'unknown', content: {} },
  ]);
  assertEquals(result.status, 200);
  const edus = theApp().federationEdus;
  assertEquals(edus.typingOf(s.id).userIds, [user()]);
  assertEquals(await edus.receiptsIn(s.id), [{
    userId: user(),
    eventIds: [String(target.event_id)],
    ts: 1234567890,
    threadId: null,
  }]);
  assertEquals((await edus.presenceOf(user()))?.presence, 'online');
  assertEquals((await edus.presenceOf(user()))?.status_msg, 'on the wire');
  assertEquals(await edus.presenceOf(foreign), null);
});

test('send: authenticated contact resets the real sender backoff', async () => {
  await setup();
  startFederationServices(theApp());
  await theApp().server.execute(
    'INSERT INTO peer_status(destination,failures,attempts_total,failures_total,unreachable_since_ms,next_attempt_ms) VALUES(?,5,9,5,?,?) ON CONFLICT(destination) DO UPDATE SET failures=5, next_attempt_ms=excluded.next_attempt_ms, unreachable_since_ms=excluded.unreachable_since_ms',
    [remote.name, Date.now() - 60_000, Date.now() + 3_600_000],
  );
  assertEquals((await peerStatus(theApp().server, remote.name)).failures, 5);
  assertEquals((await send('alive', [])).status, 200);
  const status = await peerStatus(theApp().server, remote.name);
  assertEquals(status.failures, 0);
  assertEquals(status.nextAttemptMs, 0);
  assert(status.lastInboundMs !== null);
});

test('send: missing prevs persist pending waits without news; zero retention drops without storage', async () => {
  const s = await setup();
  setConfigForTests({ federation: { missingwaitms: 0, missingbudgetms: 0 } });
  try {
    const pending = await message(s, 'pending', {
      prev_events: ['$missing-one', '$missing-two'],
    });
    assertEquals(await send('pending', [pending]), {
      status: 200,
      body: { pdus: { [String(pending.event_id)]: {} } },
    });
    await s.held.tx(async (tx) => {
      const status = await tx.events.getStatus(String(pending.event_id));
      assertEquals(status?.grounding, 'pending');
      assertEquals(status?.origin, remote.name);
      const waits = await tx.waits.of(String(pending.event_id));
      assertEquals(waits.map((w) => w.missing).sort(), [
        '$missing-one',
        '$missing-two',
      ]);
      assert(waits.every((w) => w.expires !== null));
    });
    const indexed = await theApp().server.query(
      'SELECT seq,grounding FROM event_index WHERE event=?',
      [String(pending.event_id)],
    );
    assertEquals(indexed.length, 1);
    assertEquals(indexed[0].seq, null);
    assertEquals(indexed[0].grounding, 'pending');
    setConfigForTests({
      federation: {
        missingwaitms: 0,
        missingbudgetms: 0,
        ungroundedmillihours: 0,
      },
    });
    const dropped = await message(s, 'drop', {
      prev_events: ['$other-missing'],
    });
    const result = await send('drop', [dropped]);
    assertEquals(result.status, 200);
    assert(
      ((result.body.pdus as Json)[String(dropped.event_id)] as Json).error !==
        undefined,
    );
    assertEquals(
      await s.held.tx((tx) => tx.events.get(String(dropped.event_id))),
      null,
    );
    assertEquals(
      await theApp().server.query('SELECT 1 FROM event_index WHERE event=?', [
        String(dropped.event_id),
      ]),
      [],
    );
  } finally {
    setConfigForTests({});
  }
});

for (const retention of ['default', 'zero'] as const) {
  test(`send: ${retention} ungrounded lifespan controls arrival and redelivery in /sync`, async () => {
    const s = await setup();
    // tx-http.test has no federation listener: recovery cannot fetch A.
    // Keep the configured fetch budget and default lifespan in the first case.
    setConfigForTests({
      federation: {
        missingwaitms: 0,
        ...(retention === 'zero' ? { ungroundedmillihours: 0 } : {}),
      },
    });
    try {
      if (retention === 'default') {
        assert(config().federation.ungroundedmillihours > 0);
      }
      const sync = async (since?: string) => {
        const response = await matrix(
          new Request(
            'http://x/_matrix/client/v3/sync?timeout=0' +
              (since === undefined ? '' : '&since=' + enc(since)),
            { headers: { authorization: 'Bearer ' + token } },
          ),
        );
        assertEquals(response.status, 200);
        const body = await response.json() as Json;
        const joined = ((body.rooms as Json).join as Json)[s.id] as
          | Json
          | undefined;
        const events = joined === undefined
          ? []
          : (joined.timeline as Json).events as Json[];
        return {
          next: String(body.next_batch),
          ids: events.map((event) => event.event_id),
        };
      };
      const a = await message(s, 'unreject A');
      const b = await message(s, 'unreject B', {
        prev_events: [String(a.event_id)],
        depth: a.depth! + 1,
      });
      const aId = String(a.event_id);
      const bId = String(b.event_id);
      const before = await sync();
      const first = await send(`unreject-${retention}-B`, [b]);
      assertEquals(first.status, 200);
      const receipt = (first.body.pdus as Json)[bId] as Json;
      if (retention === 'default') assertEquals(receipt, {});
      else assert(typeof receipt.error === 'string');
      const waiting = await sync(before.next);
      assertEquals(waiting.ids, []);
      assertEquals(await send(`unreject-${retention}-A`, [a]), {
        status: 200,
        body: { pdus: { [aId]: {} } },
      });
      const arrived = await sync(waiting.next);
      assertEquals(arrived.ids, retention === 'default' ? [aId, bId] : [aId]);
      const resent = await send(`unreject-${retention}-B-again`, [b]);
      assertEquals(resent, {
        status: 200,
        body: { pdus: { [bId]: {} } },
      });
      if (retention === 'default') assertEquals(resent, first);
      const after = await sync(arrived.next);
      assertEquals(after.ids, retention === 'default' ? [] : [bId]);
      assertEquals((await sync(after.next)).ids, []);
      const response = await matrix(
        new Request(
          'http://x/_matrix/client/v3/rooms/' + enc(s.id) +
            '/messages?dir=f&limit=100',
          { headers: { authorization: 'Bearer ' + token } },
        ),
      );
      assertEquals(response.status, 200);
      const page = await response.json() as Json;
      assertEquals(
        (page.chunk as Json[]).map((event) => event.event_id).filter((id) =>
          id === aId || id === bId
        ),
        [aId, bId],
      );
    } finally {
      setConfigForTests({});
    }
  });
}
