// tests/tenant-data.test.ts — account data, push rules, pushers, filters,
// media metadata and transaction ids (the engine-observable parts of the
// old account.test.ts A5/A7, pushrules.test.ts, media.test.ts, txn.test.ts
// and refresh-token.test.ts; their wire halves stay with stage 5).
import { assert, assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, type Tenant, tenantSchema } from '#engine/tenant/index.ts';
import {
  accountDataMax,
  getAccountData,
  listGlobalAccountData,
  listGlobalAccountDataSince,
  listRoomAccountData,
  putAccountData,
} from '#engine/tenant/accountdata.ts';
import {
  assertScopeKind,
  deleteRule,
  getRule,
  migrateRoomRules,
  PUSH_KINDS,
  pushStreamSeq,
  putRule,
  rulesetFor,
  setRuleActions,
  setRuleEnabled,
} from '#engine/tenant/pushrules.ts';
import { listPushers, setPusher } from '#engine/tenant/pushers.ts';
import {
  DEFAULT_ROOM_FILTER,
  eventMatchesRoomEventFilter,
  loadFilter,
  resolveFilter,
  roomEventFilterOf,
  roomFilterOf,
  storeFilter,
  validateFilterDocument,
} from '#engine/tenant/filters.ts';
import { createMedia, getMedia, markUploaded } from '#engine/tenant/media.ts';
import { lookupTransaction, recordTransaction } from '#engine/tenant/txns.ts';
import {
  consumeRefreshToken,
  issueRefreshToken,
  issueToken,
  lookupToken,
  revokeToken,
} from '#engine/tenant/auth.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { deleteDevices } from '#engine/tenant/devices.ts';

const config = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function withTenant(
  fn: (tenant: Tenant) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const store = await openStore(config(dir), {
    schemas: { tenant: tenantSchema },
  });
  try {
    await fn(await openTenant(store, 'a.test', { create: true }));
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test('account data: put/get, overwrite bumps seq, per-room, since, max, isolation', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'ad-a', password: 'pw' });
    await registerUser(tenant, { localpart: 'ad-b', password: 'pw' });
    assertEquals(await getAccountData(tenant, 'ad-a', '', 'm.x'), null);
    await putAccountData(tenant, 'ad-a', '', 'com.example.custom', {
      hello: 'world',
    });
    assertEquals(
      await getAccountData(tenant, 'ad-a', '', 'com.example.custom'),
      {
        hello: 'world',
      },
    );
    // overwrite returns the new content and moves the stream
    const seq1 = await accountDataMax(tenant, 'ad-a');
    await putAccountData(tenant, 'ad-a', '', 'com.example.custom', {
      hello: 'again',
    });
    assertEquals(
      await getAccountData(tenant, 'ad-a', '', 'com.example.custom'),
      {
        hello: 'again',
      },
    );
    const seq2 = await accountDataMax(tenant, 'ad-a');
    assert(seq2 > seq1, 'the stream moves on every write');
    // per-room rows are separate from global rows
    await putAccountData(tenant, 'ad-a', '!room:a.test', 'm.fully_read', {
      event_id: '$e1',
    });
    assertEquals(await listGlobalAccountData(tenant, 'ad-a'), [
      { type: 'com.example.custom', content: { hello: 'again' } },
    ]);
    assertEquals(await listRoomAccountData(tenant, 'ad-a', '!room:a.test'), [
      { type: 'm.fully_read', content: { event_id: '$e1' } },
    ]);
    // since delivers only newer global rows, in seq order
    await putAccountData(tenant, 'ad-a', '', 'com.example.second', 42);
    const since = await listGlobalAccountDataSince(tenant, 'ad-a', seq2);
    assertEquals(since, [{ type: 'com.example.second', content: 42 }]);
    // the other user's rows and stream are untouched
    assertEquals(await listGlobalAccountData(tenant, 'ad-b'), []);
    assertEquals(await accountDataMax(tenant, 'ad-b'), 0);
  });
});

Deno.test('push rules: scope/kind validation, invalid ids, CRUD, placement, stream', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'pr-a', password: 'pw' });
    assertScopeKind('global', 'room');
    for (const bad of ['other', '']) {
      let caught: unknown;
      try {
        assertScopeKind(bad, 'room');
      } catch (e) {
        caught = e;
      }
      assert(caught instanceof MatrixError);
      assertEquals((caught as MatrixError).status, 400);
    }
    let caught: unknown;
    try {
      assertScopeKind('global', 'bogus');
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof MatrixError);

    // the ruleset starts with every kind present and empty
    const empty = await rulesetFor(tenant, 'pr-a');
    assertEquals(Object.keys(empty).sort(), [...PUSH_KINDS].sort());
    for (const kind of PUSH_KINDS) assertEquals(empty[kind].length, 0);

    // .-prefixed (and slashed) rule ids are reserved → 400 M_INVALID_PARAM
    for (const id of ['.m.rule.master', 'a/b', 'a\\b']) {
      await assertRejects(
        () =>
          putRule(tenant, 'pr-a', 'override', id, { actions: ['notify'] }, {}),
        MatrixError,
        'M_INVALID_PARAM',
      );
    }

    // first rule of a kind lands at priority 100, enabled, not default
    await putRule(tenant, 'pr-a', 'room', '!someroom:a.test', {
      actions: ['dont_notify'],
    }, {});
    const one = await getRule(tenant, 'pr-a', 'room', '!someroom:a.test');
    assertEquals(one, {
      rule_id: '!someroom:a.test',
      actions: ['dont_notify'],
      default: false,
      enabled: true,
    });

    // a rule with no placement becomes the most important of its kind
    await putRule(
      tenant,
      'pr-a',
      'override',
      'ruleA',
      { actions: ['notify'] },
      {},
    );
    await putRule(
      tenant,
      'pr-a',
      'override',
      'ruleB',
      { actions: ['notify'] },
      {
        after: 'ruleA',
      },
    );
    await putRule(
      tenant,
      'pr-a',
      'override',
      'ruleC',
      { actions: ['notify'] },
      {
        before: 'ruleA',
      },
    );
    const ordered = await rulesetFor(tenant, 'pr-a');
    assertEquals(
      ordered.override.map((r) => r.rule_id),
      ['ruleC', 'ruleA', 'ruleB'],
    );
    // before/after with an unknown anchor → 400 M_UNKNOWN
    const noAnchor = await putRule(tenant, 'pr-a', 'override', 'ruleD', {
      actions: ['notify'],
    }, { after: 'nope' }).then(() => null, (e) => e);
    assert(noAnchor instanceof MatrixError);
    assertEquals(noAnchor.errcode, 'M_UNKNOWN');
    // an update keeps its place and enabled state
    await setRuleEnabled(tenant, 'pr-a', 'room', '!someroom:a.test', false);
    await putRule(tenant, 'pr-a', 'room', '!someroom:a.test', {
      actions: ['notify'],
    }, {});
    const updated = await getRule(tenant, 'pr-a', 'room', '!someroom:a.test');
    assertEquals(updated.enabled, false);
    assertEquals(updated.actions, ['notify']);
    assertEquals(
      (await rulesetFor(tenant, 'pr-a')).room.map((r) => r.rule_id),
      ['!someroom:a.test'],
    );
    // /actions round-trip with a tweak object
    await setRuleActions(tenant, 'pr-a', 'room', '!someroom:a.test', [
      'notify',
      { set_tweak: 'sound', value: 'default' },
    ]);
    assertEquals(
      (await getRule(tenant, 'pr-a', 'room', '!someroom:a.test')).actions,
      ['notify', { set_tweak: 'sound', value: 'default' }],
    );
    // conditions and pattern survive
    await putRule(tenant, 'pr-a', 'content', 'has-cat', {
      actions: ['notify'],
      conditions: [{ kind: 'event_match', key: 'body', pattern: '*cat*' }],
      pattern: 'cat*',
    }, {});
    const content = await getRule(tenant, 'pr-a', 'content', 'has-cat');
    assertEquals(content.pattern, 'cat*');
    assertEquals(content.conditions, [
      { kind: 'event_match', key: 'body', pattern: '*cat*' },
    ]);

    // the stream moved with every mutation, in order
    const seq = await pushStreamSeq(tenant, 'pr-a');
    assert(seq > 0);
    // a delete that empties the table still moves the stream (the marker)
    const beforeDelete = await pushStreamSeq(tenant, 'pr-a');
    await deleteRule(tenant, 'pr-a', 'room', '!someroom:a.test');
    assert((await pushStreamSeq(tenant, 'pr-a')) > beforeDelete);
    await assertRejects(
      () => getRule(tenant, 'pr-a', 'room', '!someroom:a.test'),
      MatrixError,
      'M_NOT_FOUND',
    );
    await assertRejects(
      () => deleteRule(tenant, 'pr-a', 'room', '!someroom:a.test'),
      MatrixError,
      'M_NOT_FOUND',
    );
    await assertRejects(
      () => setRuleEnabled(tenant, 'pr-a', 'room', '!gone:a.test', true),
      MatrixError,
      'M_NOT_FOUND',
    );
    await assertRejects(
      () => setRuleActions(tenant, 'pr-a', 'room', '!gone:a.test', ['notify']),
      MatrixError,
      'M_NOT_FOUND',
    );
  });
});

Deno.test('push rules: tight gap triggers a re-pack to 100-steps', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'pr-rp', password: 'pw' });
    await putRule(
      tenant,
      'pr-rp',
      'override',
      'base',
      { actions: ['notify'] },
      {},
    );
    // Each insert before 'base' lands immediately above it (the midpoint
    // of the floor and base), halving the gap: 50, 75, 87, 93, 96, 98, 99
    // — then the gap closes and the kind re-packs to 100-steps before the
    // eighth midpoint lands at 750.
    for (let i = 0; i < 8; i++) {
      await putRule(tenant, 'pr-rp', 'override', `b${i}`, {
        actions: ['notify'],
      }, {
        before: 'base',
      });
    }
    const rules = (await rulesetFor(tenant, 'pr-rp')).override;
    assertEquals(
      rules.map((r) => r.rule_id),
      ['b0', 'b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'base'],
    );
    // The re-packed 100-steps with the last midpoint at 750, exactly as
    // the old midpoint algorithm produces them.
    const priorities = await tenant.tx(async (tx) =>
      (await tx.pushRules.kindRows('pr-rp', 'override')).map((r) => r.priority)
    );
    assertEquals(priorities, [100, 200, 300, 400, 500, 600, 700, 750, 800]);
  });
});

Deno.test('push rules migration: copy for all local users, own rule wins, stream stamped', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'pm-a', password: 'pw' });
    await registerUser(tenant, { localpart: 'pm-b', password: 'pw' });
    await registerUser(tenant, { localpart: 'pm-c', password: 'pw' });
    const oldRoom = '!old:a.test';
    const newRoom = '!new:a.test';
    await putRule(
      tenant,
      'pm-a',
      'room',
      oldRoom,
      { actions: ['dont_notify'] },
      {},
    );
    await putRule(
      tenant,
      'pm-b',
      'room',
      oldRoom,
      { actions: ['dont_notify'] },
      {},
    );
    // pm-c already has an own rule on the new room — the copy must not
    // overwrite it
    await putRule(tenant, 'pm-c', 'room', newRoom, { actions: ['notify'] }, {});
    await putRule(
      tenant,
      'pm-c',
      'room',
      oldRoom,
      { actions: ['dont_notify'] },
      {},
    );
    const beforeA = await pushStreamSeq(tenant, 'pm-a');
    await migrateRoomRules(tenant, oldRoom, newRoom);
    // copy, not move: the old room's rules stay
    assertEquals(
      (await rulesetFor(tenant, 'pm-a')).room.map((r) => r.rule_id).sort(),
      [newRoom, oldRoom].sort(),
    );
    assertEquals(
      (await rulesetFor(tenant, 'pm-b')).room.map((r) => r.rule_id).sort(),
      [newRoom, oldRoom].sort(),
    );
    assertEquals(
      (await getRule(tenant, 'pm-c', 'room', newRoom)).actions,
      ['notify'],
    );
    // the touched users' streams moved; pm-c's rule was already there, so
    // only pm-a/pm-b are stamped
    assert((await pushStreamSeq(tenant, 'pm-a')) > beforeA);
    assert((await pushStreamSeq(tenant, 'pm-b')) > 0);
  });
});

Deno.test('pushers: upsert, kind null deletes, list hides the token, cascades', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'push',
      password: 'pw',
      deviceId: 'push-one',
    });
    const pusher = {
      app_id: 'com.example.app',
      pushkey: 'key-1',
      kind: 'http',
      app_display_name: 'App',
      device_display_name: 'Phone',
      lang: 'en',
      data: { url: 'https://gateway.example/_matrix/push/v1/notify' },
    };
    await setPusher(tenant, 'push', reg.access_token!, pusher);
    assertEquals(await listPushers(tenant, 'push'), [{
      app_id: 'com.example.app',
      pushkey: 'key-1',
      kind: 'http',
      app_display_name: 'App',
      device_display_name: 'Phone',
      profile_tag: null,
      lang: 'en',
      data: { url: 'https://gateway.example/_matrix/push/v1/notify' },
    }]);
    // upsert changes the row in place
    await setPusher(tenant, 'push', reg.access_token!, {
      ...pusher,
      app_display_name: 'Renamed',
      profile_tag: 'tag-1',
    });
    assertEquals((await listPushers(tenant, 'push')).length, 1);
    assertEquals(
      (await listPushers(tenant, 'push'))[0].app_display_name,
      'Renamed',
    );
    assertEquals((await listPushers(tenant, 'push'))[0].profile_tag, 'tag-1');
    // kind null deletes that (app_id, pushkey)
    await setPusher(tenant, 'push', reg.access_token!, {
      ...pusher,
      kind: null,
    });
    assertEquals(await listPushers(tenant, 'push'), []);

    // a second token's pusher survives revoking the first token
    const t2 = await issueToken(tenant, 'push', 'push-two');
    await setPusher(tenant, 'push', reg.access_token!, pusher);
    await setPusher(tenant, 'push', t2, { ...pusher, pushkey: 'key-2' });
    await revokeToken(tenant, reg.access_token!);
    const remaining = await listPushers(tenant, 'push');
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].pushkey, 'key-2');
    // deleting the device kills its tokens' pushers
    await deleteDevices(tenant, 'push', ['push-two']);
    assertEquals(await listPushers(tenant, 'push'), []);
  });
});

Deno.test('filters: validate, store/load verbatim, resolve, match', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'filt', password: 'pw' });
    // validation rejects malformed documents, ignores unknown keys
    validateFilterDocument({ unknown: 'key' });
    validateFilterDocument({
      room: { timeline: { limit: 10, types: ['m.room.message'] } },
    });
    for (
      const bad of [
        null,
        [],
        'x',
        { room: [] },
        { room: { timeline: { limit: -1 } } },
        { room: { timeline: { limit: 1.5 } } },
        { room: { state: { types: 'm.room.message' } } },
        { room: { timeline: { types: [1] } } },
        { room: { timeline: { rooms: ['not-a-room'] } } },
        { room: { timeline: { senders: ['not-a-user'] } } },
      ]
    ) {
      let caught: unknown;
      try {
        validateFilterDocument(bad);
      } catch (e) {
        caught = e;
      }
      assert(
        caught instanceof MatrixError,
        `expected M_BAD_JSON: ${JSON.stringify(bad)}`,
      );
      assertEquals((caught as MatrixError).errcode, 'M_BAD_JSON');
    }

    // ids are sequential per user; the document is stored verbatim
    const doc = { room: { timeline: { limit: 3 } }, presence: { types: [] } };
    const id0 = await storeFilter(tenant, 'filt', doc);
    const id1 = await storeFilter(tenant, 'filt', {
      room: { state: { lazy_load_members: true } },
    });
    assertEquals(id0, '0');
    assertEquals(id1, '1');
    assertEquals(await loadFilter(tenant, 'filt', '0'), doc);
    assertEquals(await loadFilter(tenant, 'filt', '9'), null);

    // resolve: absent → default; inline JSON; stored id; unknown id
    assertEquals(
      await resolveFilter(tenant, '@filt:a.test', null),
      DEFAULT_ROOM_FILTER,
    );
    assertEquals(
      await resolveFilter(
        tenant,
        '@filt:a.test',
        '{"room":{"include_leave":true}}',
      ),
      { timeline: {}, state: {}, includeLeave: true },
    );
    assertEquals(
      await resolveFilter(tenant, '@filt:a.test', '0'),
      { timeline: { limit: 3 }, state: {}, includeLeave: false },
    );
    await assertRejects(
      () => resolveFilter(tenant, '@filt:a.test', '9'),
      MatrixError,
      'M_INVALID_PARAM',
    );
    await assertRejects(
      () => resolveFilter(tenant, '@filt:a.test', '{broken'),
      MatrixError,
      'M_BAD_JSON',
    );
    // roomFilterOf/eventFilterOf defaults and lazy_load_members
    assertEquals(roomFilterOf(null), DEFAULT_ROOM_FILTER);
    assertEquals(
      roomFilterOf({ room: { state: { lazy_load_members: true } } }),
      {
        timeline: {},
        state: { lazy_load_members: true },
        includeLeave: false,
      },
    );

    // RoomEventFilter matching: types, senders, contains_url
    const filter = roomEventFilterOf({
      types: ['m.room.message'],
      not_senders: ['@bot:a.test'],
      contains_url: true,
    });
    const pdu = (type: string, sender: string, url?: string) => ({
      type,
      sender,
      content: url === undefined ? {} : { url },
    });
    assert(
      eventMatchesRoomEventFilter(
        null,
        pdu('m.room.message', '@u:a.test', 'mxc://a/b'),
        filter,
      ),
    );
    assert(
      !eventMatchesRoomEventFilter(
        null,
        pdu('m.room.notice', '@u:a.test', 'mxc://a/b'),
        filter,
      ),
    );
    assert(
      !eventMatchesRoomEventFilter(
        null,
        pdu('m.room.message', '@bot:a.test', 'mxc://a/b'),
        filter,
      ),
    );
    assert(
      !eventMatchesRoomEventFilter(
        null,
        pdu('m.room.message', '@u:a.test'),
        filter,
      ),
    );
  });
});

Deno.test('media: create pending, mark uploaded, unknown → null', async () => {
  await withTenant(async (tenant) => {
    await registerUser(tenant, { localpart: 'med', password: 'pw' });
    assertEquals(await getMedia(tenant, 'no-such-id'), null);
    await createMedia(tenant, 'med', 'media-1', 'pending');
    const pending = await getMedia(tenant, 'media-1');
    assertEquals(pending?.state, 'pending');
    assertEquals(pending?.localpart, 'med');
    assertEquals(pending?.uploaded_ms, null);
    await markUploaded(tenant, 'media-1', {
      content_type: 'image/png',
      filename: 'shot.png',
      size_bytes: 1234,
    });
    const uploaded = await getMedia(tenant, 'media-1');
    assertEquals(uploaded?.state, 'uploaded');
    assertEquals(uploaded?.content_type, 'image/png');
    assertEquals(uploaded?.filename, 'shot.png');
    assertEquals(uploaded?.size_bytes, 1234);
    assert(typeof uploaded?.uploaded_ms === 'number');
    // a direct uploaded row carries its metadata and uploaded_ms at insert
    await createMedia(tenant, 'med', 'media-2', 'uploaded', {
      content_type: 'text/plain',
      size_bytes: 5,
    });
    const direct = await getMedia(tenant, 'media-2');
    assertEquals(direct?.state, 'uploaded');
    assertEquals(direct?.uploaded_ms, direct?.created_ms);
  });
});

Deno.test('txns: (device, room, txn) → same event id, other room differs, content ignored', async () => {
  await withTenant(async (tenant) => {
    const reg = await registerUser(tenant, {
      localpart: 'txn',
      password: 'pw',
      deviceId: 'txn-one',
    });
    const device = reg.device_id;
    await recordTransaction(tenant, device, '!room1:a.test', 'm-txn', '$first');
    assertEquals(
      await lookupTransaction(tenant, device, '!room1:a.test', 'm-txn'),
      '$first',
    );
    // a repeat record (whatever the content was) is a no-op
    await recordTransaction(
      tenant,
      device,
      '!room1:a.test',
      'm-txn',
      '$second',
    );
    assertEquals(
      await lookupTransaction(tenant, device, '!room1:a.test', 'm-txn'),
      '$first',
    );
    // other room → nothing recorded
    assertEquals(
      await lookupTransaction(tenant, device, '!room2:a.test', 'm-txn'),
      null,
    );
    // other device → nothing recorded
    assertEquals(
      await lookupTransaction(tenant, 'txn-two', '!room1:a.test', 'm-txn'),
      null,
    );

    // TestTxnIdWithRefreshToken's engine half: the refresh rotates BOTH
    // tokens but the device is unchanged, so the txn scope survives
    const refresh = await issueRefreshToken(
      tenant,
      'txn',
      device,
      reg.access_token!,
    );
    const rotated = await consumeRefreshToken(tenant, refresh);
    assertEquals(
      (await lookupToken(tenant, rotated.accessToken))?.device_id,
      device,
    );
    assertEquals(
      await lookupTransaction(tenant, device, '!room1:a.test', 'm-txn'),
      '$first',
    );
  });
});
