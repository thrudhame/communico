import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { config, setConfigForTests } from '#engine/config.ts';

type Reply = {
  next_batch: string;
  room_id: string;
  event_id: string;
  changed: string[];
  left: string[];
  device_lists: { changed: string[]; left: string[] };
  device_keys: Record<string, Record<string, unknown>>;
};
const suite = httpSuite('HTTP historical E2EE device tracking');
async function call(
  token: string,
  path: string,
  body?: unknown,
  method = 'POST',
  status = 200,
): Promise<Reply> {
  const r = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: body === undefined ? 'GET' : method,
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(r.status, status, await r.clone().text());
  return await r.json();
}
const sync = (token: string, since?: string, timeout = 0) =>
  call(
    token,
    'sync?timeout=' + timeout + '&filter=' +
      encodeURIComponent(
        JSON.stringify({
          room: {
            state: { lazy_load_members: true, not_types: ['m.room.member'] },
          },
        }),
      ) + (since ? '&since=' + since : ''),
  );
const changes = (token: string, from: string, to: string) =>
  call(token, 'keys/changes?from=' + from + '&to=' + to);
const encrypt = (token: string, room: string) =>
  call(
    token,
    'rooms/' + encodeURIComponent(room) + '/state/m.room.encryption/',
    { algorithm: 'm.megolm.v1.aes-sha2' },
    'PUT',
  );

suite.test('self changes wake an empty account and keys/changes validates cuts', async () => {
  const a = await suite.registerTestUser('list-self', 'pw');
  const before = await sync(a.access_token!);
  const start = Date.now();
  const waiting = sync(a.access_token!, before.next_batch, 3000);
  await call(a.access_token!, 'devices/' + a.device_id, {
    display_name: 'renamed',
  }, 'PUT');
  const after = await waiting;
  assert(Date.now() - start < 2500);
  assertEquals(after.device_lists, { changed: [a.user_id], left: [] });
  const result = await changes(
    a.access_token!,
    before.next_batch,
    after.next_batch,
  );
  assertEquals(
    { changed: result.changed, left: result.left },
    after.device_lists,
  );
  await call(
    a.access_token!,
    'keys/changes?from=bad&to=' + after.next_batch,
    undefined,
    'GET',
    400,
  );
  await call(
    a.access_token!,
    'keys/changes?from=' + after.next_batch + '&to=' + before.next_batch,
    undefined,
    'GET',
    400,
  );
});

suite.test('all-room sync and keys changes retain bounded old audiences through leave and rejoin', async () => {
  const a = await suite.registerTestUser('list-a', 'pw');
  const b = await suite.registerTestUser('list-b', 'pw');
  const initial = await sync(a.access_token!);
  const r =
    (await call(a.access_token!, 'createRoom', { visibility: 'public' }))
      .room_id;
  await call(b.access_token!, 'join/' + encodeURIComponent(r), {});
  const plain = await sync(a.access_token!, initial.next_batch);
  assertEquals(plain.device_lists, { changed: [b.user_id], left: [] });
  assertEquals(
    (await changes(a.access_token!, initial.next_batch, plain.next_batch))
      .changed,
    [b.user_id],
  );
  await encrypt(a.access_token!, r);
  const encrypted = await sync(a.access_token!, plain.next_batch);
  assertEquals(encrypted.device_lists, { changed: [], left: [] });
  await call(
    b.access_token!,
    'devices/' + b.device_id,
    { display_name: 'new' },
    'PUT',
  );
  const modified = await sync(a.access_token!, encrypted.next_batch);
  assertEquals(modified.device_lists.changed, [b.user_id]);
  const r2 =
    (await call(a.access_token!, 'createRoom', { visibility: 'public' }))
      .room_id;
  await encrypt(a.access_token!, r2);
  await call(b.access_token!, 'join/' + encodeURIComponent(r2), {});
  const twice = await sync(a.access_token!, modified.next_batch);
  assertEquals(twice.device_lists.changed, []);
  await call(b.access_token!, 'rooms/' + encodeURIComponent(r) + '/leave', {});
  const once = await sync(a.access_token!, twice.next_batch);
  assertEquals(once.device_lists.left, []);
  await call(b.access_token!, 'rooms/' + encodeURIComponent(r2) + '/leave', {});
  const gone = await sync(a.access_token!, once.next_batch);
  assertEquals(gone.device_lists, { changed: [], left: [b.user_id] });
  // Query an old interval AFTER the audience has disappeared.
  assertEquals(
    (await changes(a.access_token!, encrypted.next_batch, modified.next_batch))
      .changed,
    [b.user_id],
  );
  await call(b.access_token!, 'devices/' + b.device_id, {
    display_name: 'unshared',
  }, 'PUT');
  const hidden = await sync(a.access_token!, gone.next_batch);
  assertEquals(hidden.device_lists, { changed: [], left: [] });
  await call(b.access_token!, 'join/' + encodeURIComponent(r), {});
  const rejoined = await sync(a.access_token!, hidden.next_batch);
  assertEquals(rejoined.device_lists.changed, [b.user_id]);
  assertEquals(
    (await changes(a.access_token!, gone.next_batch, hidden.next_batch))
      .changed,
    [],
  );
});

suite.test('plaintext sharing notifies join, mutation and last-room loss as a deliberate all-room superset', async () => {
  const a = await suite.registerTestUser('plain-list-a', 'pw');
  const b = await suite.registerTestUser('plain-list-b', 'pw');
  const initial = await sync(a.access_token!);
  const room =
    (await call(a.access_token!, 'createRoom', { visibility: 'public' }))
      .room_id;
  await call(b.access_token!, 'join/' + encodeURIComponent(room), {});
  const joined = await sync(a.access_token!, initial.next_batch);
  assertEquals(joined.device_lists, { changed: [b.user_id], left: [] });
  await call(b.access_token!, 'devices/' + b.device_id, {
    display_name: 'plain mutation',
  }, 'PUT');
  const changed = await sync(a.access_token!, joined.next_batch);
  assertEquals(changed.device_lists, { changed: [b.user_id], left: [] });
  await call(
    b.access_token!,
    'rooms/' + encodeURIComponent(room) + '/leave',
    {},
  );
  const left = await sync(a.access_token!, changed.next_batch);
  assertEquals(left.device_lists, { changed: [], left: [b.user_id] });
  // The final relationship cut wins even when the interval includes a mutation.
  assertEquals(
    (await sync(a.access_token!, joined.next_batch)).device_lists.left,
    [b.user_id],
  );
});

suite.test('joining an existing room invalidates the joiner own device list without another upload', async () => {
  const a = await suite.registerTestUser('list-join-self-a', 'pw');
  const b = await suite.registerTestUser('list-join-self-b', 'pw');
  const room =
    (await call(a.access_token!, 'createRoom', { visibility: 'public' }))
      .room_id;
  const before = await sync(b.access_token!);
  await call(b.access_token!, 'join/' + encodeURIComponent(room), {});
  const joined = await sync(b.access_token!, before.next_batch);
  assertEquals(joined.device_lists, {
    changed: [a.user_id, b.user_id].sort(),
    left: [],
  });
  const after = await sync(b.access_token!, joined.next_batch);
  assertEquals(after.device_lists, { changed: [], left: [] });
});

suite.test('peer upload and logout notify sync before query observes the new key view', async () => {
  const a = await suite.registerTestUser('list-keys-a', 'pw');
  const b = await suite.registerTestUser('list-keys-b', 'pw');
  const room =
    (await call(a.access_token!, 'createRoom', { visibility: 'public' }))
      .room_id;
  await encrypt(a.access_token!, room);
  await call(b.access_token!, 'join/' + encodeURIComponent(room), {});
  const before = await sync(a.access_token!);
  const key = {
    user_id: b.user_id,
    device_id: b.device_id,
    algorithms: ['m.olm.v1.curve25519-aes-sha2'],
    keys: { ['ed25519:' + b.device_id]: 'key' },
    signatures: {},
  };
  await call(b.access_token!, 'keys/upload', { device_keys: key });
  const uploaded = await sync(a.access_token!, before.next_batch);
  assertEquals(uploaded.device_lists.changed, [b.user_id]);
  const query = { device_keys: { [b.user_id]: [] } };
  const view = (await call(a.access_token!, 'keys/query', query))
    .device_keys[b.user_id][b.device_id];
  assertEquals(view, {
    ...key,
    unsigned: { device_display_name: 'list-keys-b' },
  });
  await call(b.access_token!, 'logout', {});
  assertEquals(
    (await sync(a.access_token!, uploaded.next_batch)).device_lists.changed,
    [b.user_id],
  );
  assertEquals(
    (await call(a.access_token!, 'keys/query', query)).device_keys[b.user_id],
    {},
  );
});

suite.test('delivery proof saturation retains newest tied cut and replays expired proofs', async () => {
  const a = await suite.registerTestUser('proof-a', 'pw');
  const b = await suite.registerTestUser('proof-b', 'pw');
  const oldLimits = { ...config().e2ee };
  try {
    setConfigForTests({ e2ee: { maxkeys: 2 } });
    await call(a.access_token!, 'sendToDevice/m.test/proof', {
      messages: { [b.user_id]: { [b.device_id]: { n: 1 } } },
    }, 'PUT');
    const old = await sync(b.access_token!);
    let latest = old;
    for (let n = 0; n < 4; n++) {
      await call(b.access_token!, 'devices/' + b.device_id, {
        display_name: 'proof-' + n,
      }, 'PUT');
      latest = await sync(b.access_token!);
    }
    // Receipt eviction cannot hide pending data or prevent the newest token from acking it.
    assertEquals(
      (await sync(b.access_token!, old.next_batch)).device_lists.left,
      [],
    );
    await sync(b.access_token!, latest.next_batch);
    const empty = await call(b.access_token!, 'sync');
    assertEquals(
      (empty as unknown as { to_device: { events: unknown[] } }).to_device
        .events,
      [],
    );
  } finally {
    setConfigForTests({ e2ee: oldLimits });
  }
});
