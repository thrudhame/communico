// Private receipts are user-scoped, including sync payloads and long-poll wakeups.
import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP private receipts');
async function call(path: string, token?: string, body?: unknown) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: token === undefined ? {} : { Authorization: 'Bearer ' + token },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  assertEquals(response.status, 200);
  return await response.json() as Json;
}
const sync = (token: string, since?: unknown, timeout = 0) =>
  call(
    'sync?timeout=' + timeout + (since === undefined ? '' : '&since=' + since),
    token,
  );
function receipts(body: Json, room: string): Json[] {
  const joined = ((body.rooms as Json).join as Json)[room] as Json | undefined;
  return (((joined?.ephemeral as Json)?.events ?? []) as Json[])
    .filter((e) => e.type === 'm.receipt').map((e) => e.content as Json);
}
async function fixture(prefix: string) {
  const a = await suite.registerTestUser(prefix + '-a', 'pw');
  const b = await suite.registerTestUser(prefix + '-b', 'pw');
  const created = await call('createRoom', a.access_token!, {
    invite: [b.user_id],
  });
  const room = String(created.room_id);
  const base = 'rooms/' + encodeURIComponent(room);
  await call(base + '/join', b.access_token!, {});
  // Settle both default-online transitions before receipt-only token cuts.
  await sync(a.access_token!);
  await sync(b.access_token!);
  // Unthreaded receipt targets can be unknown, as before F15.
  return { a, b, room, base, target: '$' + prefix };
}

suite.test('both receipt write APIs echo only to the owner, across devices and initial/delta sync', async () => {
  const { a, b, room, base, target } = await fixture('private-echo');
  const otherDevice = await call('login', undefined, {
    type: 'm.login.password',
    user: a.user_id,
    password: 'pw',
  });
  const before = await sync(a.access_token!);
  const observerBefore = await sync(b.access_token!);
  await call(base + '/receipt/m.read/' + target, a.access_token!, {});
  await call(base + '/receipt/m.read.private/' + target, a.access_token!, {});
  for (
    const body of [
      await sync(a.access_token!, before.next_batch),
      await sync(String(otherDevice.access_token)),
    ]
  ) {
    const mark = receipts(body, room).find((c) =>
      ((c[target] as Json)?.['m.read.private'] as Json)?.[a.user_id]
    );
    assert(mark !== undefined, 'owner must receive its private receipt');
    const users = (mark[target] as Json)['m.read.private'] as Json;
    assertEquals(Object.keys(users), [a.user_id]);
    assertEquals(typeof (users[a.user_id] as Json).ts, 'number');
  }
  const observer = receipts(
    await sync(b.access_token!, observerBefore.next_batch),
    room,
  );
  assert(JSON.stringify(observer).includes('m.read'));
  assert(!JSON.stringify(observer).includes('m.read.private'));
  assert(
    !JSON.stringify(receipts(await sync(b.access_token!), room)).includes(
      'm.read.private',
    ),
  );
  const next = await sync(a.access_token!);
  await call(base + '/read_markers', a.access_token!, {
    'm.read.private': target + '-marker',
  });
  assert(
    receipts(await sync(a.access_token!, next.next_batch), room).some((c) =>
      ((c[target + '-marker'] as Json)?.['m.read.private'] as Json)?.[a.user_id]
    ),
  );
});

suite.test('private receipt wakes its owner, never another joined user', async () => {
  const { a, b, room, base, target } = await fixture('private-wake');
  const ownerBefore = await sync(a.access_token!);
  const observerBefore = await sync(b.access_token!);
  let observerFinished = false;
  const ownerWait = sync(a.access_token!, ownerBefore.next_batch, 3000);
  const observerWait = sync(b.access_token!, observerBefore.next_batch, 3000)
    .then((body) => {
      observerFinished = true;
      return body;
    });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await call(base + '/receipt/m.read.private/' + target, a.access_token!, {});
  const owner = await ownerWait;
  await new Promise((resolve) => setTimeout(resolve, 80));
  const stayedPending = !observerFinished;
  await call(base + '/receipt/m.read/' + target, a.access_token!, {});
  const observer = await observerWait;
  assert(
    stayedPending,
    'another user must not observe a private receipt through early sync completion',
  );
  assert(
    JSON.stringify(receipts(owner, room)).includes('m.read.private'),
    JSON.stringify({
      presence: owner.presence,
      receipts: receipts(owner, room),
    }),
  );
  assert(!JSON.stringify(receipts(observer, room)).includes('m.read.private'));
});
