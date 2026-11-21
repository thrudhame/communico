import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  getPresence,
  setPresence,
  setPresenceValue,
  withPresenceSync,
} from '#engine/server/ephemeral.ts';
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
