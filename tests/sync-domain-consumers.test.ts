import { assert, assertEquals, assertRejects } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { encodeStreamToken, parseStreamToken } from '#engine/client/tokens.ts';
import { getPresence, setPresenceValue } from '#engine/server/ephemeral.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { insertMessage } from '#engine/tenant/todevice.ts';
import { httpSuite } from '#tests/http-app.ts';
import { syncFor } from '#engine/syncfeed.ts';
import { DEFAULT_ROOM_FILTER } from '#engine/tenant/filters.ts';
import { MatrixError } from '#engine/matrix-error.ts';

const suite = httpSuite('HTTP stream publication domains');
type Json = Record<string, unknown>;
async function call(path: string, access: string, body?: unknown) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + access },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: response.status, body: await response.json() as Json };
}
const base = '/_matrix/client/v3';

suite.test('issued sync positions use the existing durable publication domain', async () => {
  const user = await suite.registerTestUser('domain-issue', 'pw');
  const response = await call(base + '/sync', user.access_token!);
  assertEquals(response.status, 200);
  const [identity] = await theApp().server.query(
    'SELECT domain FROM publication_domain WHERE singleton=1',
  );
  assertEquals(
    parseStreamToken(String(response.body.next_batch))?.domain,
    identity.domain,
  );
});

suite.test('foreign since is rejected before presence, inbox publication and delivery receipt effects', async () => {
  const user = await suite.registerTestUser('domain-effect', 'pw');
  const app = theApp();
  const db = await app.store.tenant(app.tenant.serverName);
  const device = await deviceIdentity(
    app.tenant,
    'domain-effect',
    user.device_id!,
  );
  await db.tx((conn) =>
    insertMessage(conn, device, 'domain-pending', {
      type: 'm.room_key',
      content: { retained: true },
    }, config().e2ee)
  );
  const first = await call(base + '/sync', user.access_token!);
  assertEquals(first.status, 200);
  const position = parseStreamToken(String(first.body.next_batch))!;
  await setPresenceValue(app.server, user.user_id, 'offline');
  const beforePresence = await getPresence(app.server, user.user_id);
  const beforeInbox = await db.query('SELECT * FROM to_device_inbox');
  const beforeReceipts = await db.query('SELECT * FROM sync_deliveries');
  const foreign = encodeStreamToken({
    ...position,
    domain: crypto.randomUUID(),
  });
  const result = await call(
    base + '/sync?since=' + foreign + '&set_presence=online',
    user.access_token!,
  );
  assertEquals(result, {
    status: 400,
    body: {
      errcode: 'M_UNKNOWN_POS',
      error: 'foreign sync position; retry without since for a full resync',
    },
  });
  const foreignRecovery = await call(
    base + '/sync?since=' + encodeStreamToken({
      ...position,
      domain: crypto.randomUUID(),
      epoch: 'f'.repeat(32),
      eSeq: Number.MAX_SAFE_INTEGER,
      mSeq: Number.MAX_SAFE_INTEGER,
    }),
    user.access_token!,
  );
  assertEquals(foreignRecovery, result);
  assertEquals(await getPresence(app.server, user.user_id), beforePresence);
  assertEquals(await db.query('SELECT * FROM to_device_inbox'), beforeInbox);
  assertEquals(
    await db.query('SELECT * FROM sync_deliveries'),
    beforeReceipts,
  );
  // Removing the namespace is not rewriting an issued receipt into authority.
  const legacy = encodeStreamToken({ ...position, domain: undefined });
  const replay = await call(base + '/sync?since=' + legacy, user.access_token!);
  assertEquals(replay.status, 200);
  assertEquals(replay.body.to_device, first.body.to_device);
  const acknowledged = await call(
    base + '/sync?since=' + replay.body.next_batch,
    user.access_token!,
  );
  assertEquals(acknowledged.body.to_device, { events: [] });
});

suite.test('foreign domain admission precedes even completion cancellation', async () => {
  const user = await suite.registerTestUser('domain-before-completion', 'pw');
  const rejected = await assertRejects(
    () =>
      syncFor({
        userId: user.user_id,
        deviceId: user.device_id!,
        since: { ...parseStreamToken('s0')!, domain: crypto.randomUUID() },
        timeoutMs: 0,
        fullState: false,
        filter: DEFAULT_ROOM_FILTER,
        signal: AbortSignal.abort(new Error('completion entered')),
      }),
    MatrixError,
    'foreign sync position',
  );
  assertEquals(rejected.errcode, 'M_UNKNOWN_POS');
});

suite.test('foreign equal-number bookmarks are rejected by every stream-cut consumer before selecting local data', async () => {
  const user = await suite.registerTestUser('domain-consumers', 'pw');
  const created = await call(base + '/createRoom', user.access_token!, {});
  assertEquals(created.status, 200);
  const room = encodeURIComponent(String(created.body.room_id));
  const initial = await call(base + '/sync', user.access_token!);
  const own = String(initial.body.next_batch);
  const foreign = encodeStreamToken({
    ...parseStreamToken(own)!,
    domain: crypto.randomUUID(),
  });
  const paths = [
    '/keys/changes?from=' + foreign + '&to=' + own,
    '/keys/changes?from=' + own + '&to=' + foreign,
    '/rooms/' + room + '/members?at=' + foreign,
    '/rooms/' + room + '/messages?dir=b&from=' + foreign,
    '/events?room_id=' + room + '&from=' + foreign + '&timeout=0',
  ];
  for (const path of paths) {
    const response = await call(base + path, user.access_token!);
    assertEquals(response.status, 400, path);
    assertEquals(response.body.errcode, 'M_UNKNOWN_POS', path);
  }
  const search = await call(
    base + '/search?next_batch=' + foreign,
    user.access_token!,
    {
      search_categories: {
        room_events: { search_term: 'test', order_by: 'recent' },
      },
    },
  );
  assertEquals(search.status, 400);
  assertEquals(search.body.errcode, 'M_UNKNOWN_POS');
  const next = await call(base + '/sync?since=' + own, user.access_token!);
  assertEquals(next.status, 200);
  assert(parseStreamToken(String(next.body.next_batch)));
});
