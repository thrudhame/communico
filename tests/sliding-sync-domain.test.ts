import { assert, assertEquals, assertRejects } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { formatPosition, parsePosition } from '#engine/client/tokens.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { getPresence, setPresenceValue } from '#engine/server/ephemeral.ts';
import { slidingSync } from '#engine/sliding-sync/index.ts';
import { slidingSyncRequest } from '#engine/sliding-sync/request.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { insertMessage } from '#engine/tenant/todevice.ts';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP sliding publication domains');
const object = (value: unknown) => value as Json;
const page = (response: Json) => object(object(response.extensions).to_device);
const numbers = (response: Json) =>
  (page(response).events as Json[]).map((e) => object(e.content).n);
const route = '/_matrix/client/unstable/org.matrix.simplified_msc3575/sync';

async function fixture(name: string) {
  const user = await suite.registerTestUser(name, 'pw');
  const app = theApp();
  const db = await app.store.tenant(app.tenant.serverName);
  const device = await deviceIdentity(app.tenant, name, user.device_id!);
  const [identity] = await app.server.query('SELECT * FROM publication_domain');
  const request = {
    conn_id: 'encryption',
    extensions: { to_device: { enabled: true, limit: 1 } },
  };
  const sync = async (
    body: Json = request,
    pos?: unknown,
    presence?: string,
  ) => {
    const query = new URLSearchParams({ timeout: '0' });
    if (pos !== undefined) query.set('pos', String(pos));
    if (presence !== undefined) query.set('set_presence', presence);
    const response = await suite.matrix(
      new Request('http://x' + route + '?' + query, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token! },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: await response.json() as Json };
  };
  const send = (n: number) =>
    db.tx((conn) =>
      insertMessage(conn, device, name + n, {
        type: 'm.room_key',
        content: { n },
      }, config().e2ee)
    );
  const snapshot = async () => ({
    connections: await db.query(
      'SELECT * FROM sliding_sync_connections ORDER BY id',
    ),
    positions: await db.query(
      'SELECT * FROM sliding_sync_positions ORDER BY token',
    ),
    receipts: await db.query(
      'SELECT * FROM sync_deliveries ORDER BY token_hash',
    ),
    inbox: await db.query('SELECT * FROM to_device_inbox ORDER BY msg_pos'),
    ack: await db.query(
      'SELECT * FROM device_ack ORDER BY localpart,device_id,generation',
    ),
    presence: await getPresence(app.server, user.user_id),
  });
  return { app, user, db, device, identity, request, sync, send, snapshot };
}

suite.test('issued top-level and inbox positions carry the existing publication domain and exact receipt', async () => {
  const f = await fixture('sliding-domain-issue');
  await f.send(1);
  await f.send(2);
  const first = await f.sync();
  assertEquals(first.status, 200);
  assertEquals(
    parsePosition(String(first.body.pos))?.domain,
    f.identity.domain,
  );
  const receipt = String(page(first.body).next_batch);
  assertEquals(parsePosition(receipt)?.domain, f.identity.domain);
  assertEquals(numbers(first.body), [1]);
  const follow = (since: string, pos: unknown) =>
    f.sync({
      ...f.request,
      extensions: { to_device: { enabled: true, limit: 1, since } },
    }, pos);
  const stripped = await follow(
    parsePosition(receipt)!.payload,
    first.body.pos,
  );
  assertEquals(stripped.status, 200);
  assertEquals(
    numbers(stripped.body),
    [1],
    'stripping the domain cannot manufacture a receipt',
  );
  const top = await follow(String(stripped.body.pos), stripped.body.pos);
  assertEquals(
    numbers(top.body),
    [1],
    'top-level positions never acknowledge the inbox',
  );
  const acknowledged = await follow(
    String(page(top.body).next_batch),
    top.body.pos,
  );
  assertEquals(acknowledged.status, 200);
  assertEquals(
    numbers(acknowledged.body),
    [2],
    'the exact issued wire token acknowledges only its returned prefix',
  );
});

suite.test('foreign top-level and enabled-extension positions refuse before completion, leases, presence or inbox effects', async () => {
  const f = await fixture('sliding-domain-effects');
  await f.send(1);
  const first = await f.sync();
  assertEquals(first.status, 200);
  const changed = crypto.randomUUID();
  await f.app.server.execute('UPDATE publication_domain SET domain=?', [
    changed,
  ]);
  await setPresenceValue(f.app.server, f.user.user_id, 'offline');
  const before = await f.snapshot();
  try {
    const foreign = await f.sync(f.request, first.body.pos, 'online');
    assertEquals([foreign.status, foreign.body.errcode], [
      400,
      'M_UNKNOWN_POS',
    ]);
    assertEquals(await f.snapshot(), before);
    const extension = await f.sync(
      {
        ...f.request,
        extensions: {
          to_device: { enabled: true, since: page(first.body).next_batch },
        },
      },
      undefined,
      'online',
    );
    assertEquals([extension.status, extension.body.errcode], [
      400,
      'M_UNKNOWN_POS',
    ]);
    assertEquals(await f.snapshot(), before);
    for (const raw of [String(first.body.pos), 'v1.not-canonical']) {
      const error = await assertRejects(() =>
        slidingSync({
          userId: f.user.user_id,
          deviceId: f.user.device_id!,
          generation: f.device.generation,
          request: slidingSyncRequest(
            f.request,
            new URLSearchParams({ pos: raw }),
            0,
          ),
          signal: AbortSignal.abort(new Error('completion entered')),
        }), MatrixError);
      assertEquals(error.errcode, 'M_UNKNOWN_POS');
    }
    assertEquals(await f.snapshot(), before);
  } finally {
    await f.app.server.execute('UPDATE publication_domain SET domain=?', [
      f.identity.domain,
    ]);
  }
});

suite.test('disabled extensions ignore foreign since and no-pos replacement preserves unacknowledged messages', async () => {
  const f = await fixture('sliding-domain-disabled');
  await f.send(1);
  await f.send(2);
  const first = await f.sync();
  assertEquals(first.status, 200);
  const before = await f.snapshot();
  const disabled = await f.sync({
    ...f.request,
    extensions: {
      to_device: {
        enabled: false,
        since: formatPosition(crypto.randomUUID(), 'foreign'),
      },
    },
  }, first.body.pos);
  assertEquals(disabled.status, 200);
  assertEquals(object(disabled.body.extensions).to_device, undefined);
  const after = await f.snapshot();
  assertEquals(after.inbox, before.inbox);
  assertEquals(after.receipts, before.receipts);
  assertEquals(after.ack, before.ack);
  const replacement = await f.sync({
    ...f.request,
    extensions: {
      to_device: {
        enabled: true,
        limit: 1,
        since: page(first.body).next_batch,
      },
    },
  });
  assertEquals(replacement.status, 200);
  assertEquals(
    numbers(replacement.body),
    [1],
    'no-pos creates a new receipt scope rather than consuming the previous connection',
  );
  assert(typeof replacement.body.pos === 'string');
  assertEquals(
    (await f.sync(f.request, first.body.pos)).body.errcode,
    'M_UNKNOWN_POS',
  );
});

suite.test('original-home legacy issued positions resume exactly while a facade refuses their unbound spelling', async () => {
  const f = await fixture('sliding-domain-legacy');
  await f.send(1);
  await f.send(2);
  const legacy = await f.app.tenant.tx(async (tx) => {
    const lease = await tx.slidingSync.begin(f.device, 'encryption', null);
    const inbox = await tx.toDevice.deliverSliding(
      f.device,
      lease.connection,
      1,
      config().e2ee,
    );
    const pos = await tx.slidingSync.commit(f.device, lease, {});
    return { pos, receipt: inbox.nextBatch };
  });
  assertEquals(parsePosition(legacy.pos), null);
  const resumed = await f.sync({
    ...f.request,
    extensions: {
      to_device: { enabled: true, limit: 1, since: legacy.receipt },
    },
  }, legacy.pos);
  assertEquals(resumed.status, 200);
  assertEquals(numbers(resumed.body), [2]);
  assertEquals(
    parsePosition(String(resumed.body.pos))?.domain,
    f.identity.domain,
  );
  await f.app.server.execute("UPDATE publication_domain SET node='facade-a'");
  try {
    const before = await f.snapshot();
    const rejected = await f.sync(f.request, legacy.pos);
    assertEquals([rejected.status, rejected.body.errcode], [
      400,
      'M_UNKNOWN_POS',
    ]);
    assertEquals(await f.snapshot(), before);
    const rejectedReceipt = await f.sync({
      ...f.request,
      extensions: { to_device: { enabled: true, since: legacy.receipt } },
    }, resumed.body.pos);
    assertEquals([rejectedReceipt.status, rejectedReceipt.body.errcode], [
      400,
      'M_UNKNOWN_POS',
    ]);
    assertEquals(await f.snapshot(), before);
    assertEquals((await f.sync(f.request, resumed.body.pos)).status, 200);
  } finally {
    await f.app.server.execute('UPDATE publication_domain SET node=?', [
      f.identity.node,
    ]);
  }
});
