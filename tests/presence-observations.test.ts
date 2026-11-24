import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  captureLocalPresence,
  ensurePresenceRow,
  getPresence,
  onEphemeral,
  replacePresenceSource,
  setPresence,
  setPresenceValue,
  withPresenceSync,
} from '#engine/server/ephemeral.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'presence-observations-' });
  const open = () =>
    openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema } });
  const store = await open();
  return { dir, open, store, server: await store.server() };
}

Deno.test('presence live source: source/device union survives independent replacement without status or re-export', async () => {
  const f = await fixture();
  const clock = Date.now;
  const start = clock();
  Date.now = () => start;
  const user = '@local:local.test';
  const phone = { deviceId: 'PHONE', generation: 1 };
  const a = { node: 'edge-a', incarnation: 'a1' };
  const b = { node: 'edge-b', incarnation: 'b1' };
  try {
    await setPresence(f.server, user, 'offline', 'retained status');
    await setPresenceValue(f.server, user, 'online', phone);
    const values = await captureLocalPresence(f.server);
    assertEquals(values, [{
      userId: user,
      ...phone,
      presence: 'online',
      remainingMs: 30_000,
      lastActiveAgo: 0,
    }]);
    await replacePresenceSource(f.server, a, values, () => 0, async () => {});
    await replacePresenceSource(
      f.server,
      b,
      values.map((v) => ({ ...v, presence: 'unavailable' })),
      () => 0,
      async () => {},
    );
    await setPresenceValue(f.server, user, 'offline', phone);
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    assertEquals(await captureLocalPresence(f.server), []);
    await replacePresenceSource(f.server, a, [], () => 0, async () => {});
    assertEquals((await getPresence(f.server, user)).presence, 'unavailable');
    await replacePresenceSource(f.server, b, [], () => 0, async () => {});
    const row = await getPresence(f.server, user);
    assertEquals(row.presence, 'offline');
    assertEquals(row.statusMsg, 'retained status');
  } finally {
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence live source: delayed and repeated observations expire without renewal, including cold reopen', async () => {
  const f = await fixture();
  const clock = Date.now;
  const start = clock();
  let now = start;
  Date.now = () => now;
  let store = f.store;
  const source = { node: 'edge-a', incarnation: 'a1' };
  const user = '@local:local.test';
  const values = [{
    userId: user,
    deviceId: 'PHONE',
    generation: 1,
    presence: 'online',
    remainingMs: 30_000,
    lastActiveAgo: 0,
  }];
  try {
    await replacePresenceSource(
      f.server,
      source,
      values,
      () => now - start,
      async () => {},
    );
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    now += 20_000;
    await replacePresenceSource(
      f.server,
      source,
      values,
      () => now - start,
      async () => {},
    );
    now += 11_000;
    assertEquals((await getPresence(f.server, user)).presence, 'offline');
    await replacePresenceSource(
      f.server,
      source,
      values,
      () => now - start,
      async () => {},
    );
    assertEquals((await getPresence(f.server, user)).presence, 'offline');
    await store.close();
    store = await f.open();
    assertEquals(
      (await getPresence(await store.server(), user)).presence,
      'offline',
    );
  } finally {
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence live source: admission failure leaves rows/cuts intact and admission waits consume lifetime', async () => {
  const f = await fixture();
  const clock = Date.now;
  const start = clock();
  let now = start;
  Date.now = () => now;
  const source = { node: 'edge-a', incarnation: 'a1' };
  const user = '@local:local.test';
  const values = [{
    userId: user,
    deviceId: 'PHONE',
    generation: 1,
    presence: 'online',
    remainingMs: 30_000,
    lastActiveAgo: 0,
  }];
  const notifications: unknown[] = [];
  const off = onEphemeral((db, change) => {
    if (db === f.server) notifications.push(change);
  });
  try {
    await replacePresenceSource(
      f.server,
      source,
      values,
      () => 0,
      async () => {},
    );
    const held = await getPresence(f.server, user);
    const count = notifications.length;
    await assertRejects(
      () =>
        replacePresenceSource(f.server, source, [], () => 0, () => {
          throw new MatrixError(503, 'M_UNAVAILABLE', 'held account admission');
        }),
      MatrixError,
    );
    assertEquals(await getPresence(f.server, user), held);
    assertEquals(notifications.length, count);
    await replacePresenceSource(
      f.server,
      source,
      values,
      () => now - start,
      () => {
        now += 31_000;
        return Promise.resolve();
      },
    );
    assertEquals((await getPresence(f.server, user)).presence, 'offline');
  } finally {
    off();
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence live source: same device generations are source-local and new incarnation replaces only its node', async () => {
  const f = await fixture();
  const clock = Date.now;
  const start = clock();
  Date.now = () => start;
  const user = '@local:local.test';
  const values = [{
    userId: user,
    deviceId: 'PHONE',
    generation: 99,
    presence: 'unavailable',
    remainingMs: 30_000,
    lastActiveAgo: 0,
  }];
  try {
    await replacePresenceSource(
      f.server,
      { node: 'edge-a', incarnation: 'a1' },
      values,
      () => 0,
      async () => {},
    );
    await replacePresenceSource(
      f.server,
      { node: 'edge-b', incarnation: 'b1' },
      values.map((v) => ({ ...v, generation: 1, presence: 'online' })),
      () => 0,
      async () => {},
    );
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    await replacePresenceSource(
      f.server,
      { node: 'edge-a', incarnation: 'a2' },
      [],
      () => 0,
      async () => {},
    );
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    assertEquals(
      (await f.server.query('SELECT DISTINCT node FROM presence_observations'))
        .map((row) => row.node),
      ['edge-b'],
    );
    const held = await getPresence(f.server, user);
    for (
      const input of [
        [...values, ...values],
        values.map((v) => ({ ...v, remainingMs: -1 })),
      ]
    ) {
      await assertRejects(
        () =>
          replacePresenceSource(
            f.server,
            { node: 'edge-b', incarnation: 'b1' },
            input,
            () => 0,
            async () => {},
          ),
        MatrixError,
      );
      assertEquals(await getPresence(f.server, user), held);
    }
  } finally {
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence live source: bounded activity lifetime cannot be extended by a recent last-active age or local sync lease', async () => {
  const f = await fixture();
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  const user = '@local:local.test';
  try {
    await withPresenceSync(f.server, user, 'offline', {
      deviceId: 'PHONE',
      generation: 1,
    }, async () => {
      await replacePresenceSource(
        f.server,
        { node: 'edge-a', incarnation: 'a1' },
        [{
          userId: user,
          deviceId: 'PHONE',
          generation: 1,
          presence: 'online',
          remainingMs: 5_000,
          lastActiveAgo: 0,
        }],
        () => 0,
        async () => {},
      );
      assertEquals((await getPresence(f.server, user)).presence, 'online');
      now += 5_001;
      assertEquals((await getPresence(f.server, user)).presence, 'offline');
    });
  } finally {
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence live source: login and historical unknown-freshness placeholders admit same-identity activity without renewing remote users', async () => {
  const f = await fixture();
  try {
    const user = '@local:local.test';
    await ensurePresenceRow(f.server, user);
    assertEquals(
      (await f.server.query(
        'SELECT remote_received_ms FROM presence WHERE user_id=?',
        [user],
      ))[0].remote_received_ms,
      null,
    );
    await f.server.execute(
      'UPDATE presence SET remote_received_ms=0 WHERE user_id=?',
      [user],
    );
    await replacePresenceSource(
      f.server,
      { node: 'edge-a', incarnation: 'a1' },
      [{
        userId: user,
        deviceId: 'PHONE',
        generation: 1,
        presence: 'online',
        remainingMs: 30_000,
        lastActiveAgo: 0,
      }],
      () => 0,
      async () => {},
    );
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    await f.server.execute(
      "INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq,remote_received_ms) VALUES('@remote:elsewhere.test','online',NULL,0,0,0)",
    );
    assertEquals(
      (await getPresence(f.server, '@remote:elsewhere.test')).presence,
      'offline',
    );
  } finally {
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence live source: fractional receiver delay preserves integer timestamps without extending lifetime', async () => {
  const f = await fixture();
  const clock = Date.now;
  let now = clock();
  const start = now;
  Date.now = () => now;
  try {
    const userId = '@local:local.test';
    await replacePresenceSource(
      f.server,
      { node: 'edge-a', incarnation: 'a1' },
      [{
        userId,
        deviceId: 'PHONE',
        generation: 1,
        presence: 'online',
        remainingMs: 5_000,
        lastActiveAgo: 0,
      }],
      () => 0.5,
      async () => {},
    );
    const [row] = await f.server.query(
      'SELECT typeof(last_active_ms) AS activity,typeof(last_sync_ms) AS sync,last_active_ms,last_sync_ms FROM presence_observations',
    );
    assertEquals(row, {
      activity: 'integer',
      sync: 'integer',
      last_active_ms: start - 1,
      last_sync_ms: start + 4_999 - 30_000,
    });
    assertEquals((await getPresence(f.server, userId)).presence, 'online');
    now += 5_000;
    assertEquals((await getPresence(f.server, userId)).presence, 'offline');
  } finally {
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('local presence aggregates fresh device observations instead of the last caller', async () => {
  const f = await fixture();
  try {
    const user = '@local:local.test';
    const phone = { deviceId: 'PHONE', generation: 1 };
    const desktop = { deviceId: 'DESKTOP', generation: 1 };
    await setPresence(f.server, user, 'offline', 'retained status');
    await setPresenceValue(f.server, user, 'online', phone);
    await setPresenceValue(f.server, user, 'unavailable', desktop);
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    await setPresenceValue(f.server, user, 'offline', phone);
    assertEquals((await getPresence(f.server, user)).presence, 'unavailable');
    await setPresenceValue(f.server, user, 'offline', desktop);
    const offline = await getPresence(f.server, user);
    assertEquals(offline.presence, 'offline');
    assertEquals(offline.statusMsg, 'retained status');
    await setPresenceValue(f.server, user, 'online', phone);
    assertEquals((await getPresence(f.server, user)).presence, 'online');
  } finally {
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('local presence holds an active sync through idle and starts offline grace only after completion', async () => {
  const f = await fixture();
  const clock = Date.now;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let syncing: Promise<void> | undefined;
  try {
    const start = clock();
    Date.now = () => start;
    const user = '@local:local.test';
    await setPresence(f.server, user, 'offline', 'retained status');
    syncing = withPresenceSync(f.server, user, 'online', {
      deviceId: 'PHONE',
      generation: 1,
    }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    Date.now = () => start + 31_000;
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    Date.now = () => start + 5 * 60_000 + 1_000;
    assertEquals((await getPresence(f.server, user)).presence, 'unavailable');
    release.resolve();
    await syncing;
    Date.now = () => start + 5 * 60_000 + 20_000;
    assertEquals((await getPresence(f.server, user)).presence, 'unavailable');
    Date.now = () => start + 5 * 60_000 + 32_000;
    assertEquals((await getPresence(f.server, user)).presence, 'offline');
  } finally {
    release.resolve();
    await syncing;
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('local presence cannot let an old device generation overwrite a newer observation', async () => {
  const f = await fixture();
  try {
    const user = '@local:local.test';
    await setPresenceValue(f.server, user, 'online', {
      deviceId: 'PHONE',
      generation: 1,
    });
    await setPresenceValue(f.server, user, 'online', {
      deviceId: 'PHONE',
      generation: 2,
    });
    await setPresenceValue(f.server, user, 'offline', {
      deviceId: 'PHONE',
      generation: 1,
    });
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    await setPresenceValue(f.server, user, 'offline', {
      deviceId: 'PHONE',
      generation: 2,
    });
    assertEquals((await getPresence(f.server, user)).presence, 'offline');
  } finally {
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('local presence cold reopen preserves receipt age instead of renewing activity', async () => {
  const f = await fixture();
  const clock = Date.now;
  let store = f.store;
  try {
    const start = clock();
    Date.now = () => start;
    const user = '@local:local.test';
    await setPresence(f.server, user, 'offline', 'retained status');
    await setPresenceValue(f.server, user, 'online', {
      deviceId: 'PHONE',
      generation: 1,
    });
    await store.close();
    Date.now = () => start + 31_000;
    store = await f.open();
    const row = await getPresence(await store.server(), user);
    assertEquals(row.presence, 'offline');
    assertEquals(row.statusMsg, 'retained status');
  } finally {
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('local presence sync lifetime belongs to its database owner, not a reopened file path', async () => {
  const f = await fixture();
  const clock = Date.now;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let store = f.store;
  let syncing: Promise<void> | undefined;
  try {
    const start = clock();
    Date.now = () => start;
    const user = '@local:local.test';
    syncing = withPresenceSync(f.server, user, 'online', {
      deviceId: 'PHONE',
      generation: 1,
    }, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    await store.close();
    Date.now = () => start + 31_000;
    store = await f.open();
    assertEquals(
      (await getPresence(await store.server(), user)).presence,
      'offline',
    );
  } finally {
    release.resolve();
    if (syncing) {
      await assertRejects(
        () => syncing!,
        Error,
        'store is closed',
      );
    }
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('local presence refreshes identical device observations without rewriting the public stream', async () => {
  const f = await fixture();
  const clock = Date.now;
  try {
    const start = clock();
    Date.now = () => start;
    const user = '@local:local.test';
    const phone = { deviceId: 'PHONE', generation: 1 };
    await setPresence(f.server, user, 'offline', 'retained status');
    await setPresenceValue(f.server, user, 'online', phone);
    const fresh = await getPresence(f.server, user);
    Date.now = () => start + 20_000;
    await setPresenceValue(f.server, user, 'online', phone);
    assertEquals(await getPresence(f.server, user), fresh);
    Date.now = () => start + 40_000;
    assertEquals((await getPresence(f.server, user)).presence, 'online');
    // Synapse's sync-online grace is 30s after the last completed sync, not
    // 30s after the last change to the aggregate/public stream.
    Date.now = () => start + 51_000;
    const expired = await getPresence(f.server, user);
    assertEquals(expired.presence, 'offline');
    assertEquals(expired.statusMsg, 'retained status');
    assert(expired.seq > fresh.seq);
    assertEquals((await getPresence(f.server, user)).seq, expired.seq);
  } finally {
    Date.now = clock;
    await f.store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});
