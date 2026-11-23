import { assert, assertEquals, assertRejects } from '@std/assert';
import {
  capturePresence,
  getPresence,
  importPresenceStatus,
  onEphemeral,
  presenceFor,
  publishPresence,
  replacePresenceSource,
  setPresence,
  withPresenceSync,
} from '#engine/server/ephemeral.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { eventStreamTx, onEventStream } from '#engine/server/stream.ts';
import { openStore } from '#engine/store/index.ts';
import { historicalServerSchema } from '#tests/fixtures/server-schema-history.ts';
import { bounded } from '#tests/helpers/server-process.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'presence-freshness-' });
  const open = (schema = serverSchema) =>
    openStore({
      dir,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: schema } });
  return { dir, open };
}

Deno.test('presence freshness expires an observation, not the remote activity timestamp or explicit status', async () => {
  const f = await fixture();
  const store = await f.open();
  const now = Date.now;
  try {
    const server = await store.server();
    const user = '@remote:origin.test';
    const received = now();
    Date.now = () => received;
    // A just-received remote observation can report activity from long ago.
    // Synapse expires remote observations after 30 minutes without an update,
    // not 30 minutes after the user's last activity.
    await setPresence(server, user, 'online', 'retained status', {
      lastActiveAgo: 90 * 60 * 1000,
      remote: true,
    });
    const fresh = await getPresence(server, user);
    assertEquals(fresh.presence, 'online');
    assertEquals(fresh.lastActiveMs, received - 90 * 60 * 1000);
    Date.now = () => received + 30 * 60 * 1000 - 1;
    assertEquals((await getPresence(server, user)).seq, fresh.seq);
    Date.now = () => received + 31 * 60 * 1000;
    const notifications: number[] = [];
    const stop = onEphemeral((db, change) => {
      if (db.path === server.path && change.kind === 'presence') {
        notifications.push(change.row.seq);
      }
    });
    const reads = await Promise.all(
      Array.from({ length: 8 }, () => getPresence(server, user)),
    );
    stop();
    const expired = reads[0];
    assert(
      reads.every((row) =>
        row.presence === 'offline' && row.seq === expired.seq
      ),
    );
    assertEquals(notifications, [expired.seq]);
    assertEquals(expired.presence, 'offline');
    assertEquals(expired.statusMsg, 'retained status');
    assert(expired.seq > fresh.seq);
    assertEquals((await getPresence(server, user)).seq, expired.seq);
    await setPresence(server, user, 'online', 'next observation', {
      remote: true,
    });
    assertEquals((await getPresence(server, user)).presence, 'online');
  } finally {
    Date.now = now;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence audience reads share freshness capture without waking their own event-stream wait', async () => {
  const f = await fixture();
  const store = await f.open();
  const clock = Date.now;
  let stopPresence = () => {}, stopStream = () => {};
  try {
    const server = await store.server();
    const user = '@remote:origin.test', observer = '@viewer:local.test';
    const received = clock();
    Date.now = () => received;
    await setPresence(server, user, 'online', 'audience status', {
      remote: true,
    });
    for (const member of [user, observer]) {
      await server.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
        member,
        '!presence:origin.test',
        'join',
        '$join',
        1,
      ]);
    }
    const notices: number[] = [];
    let streamWakes = 0;
    stopPresence = onEphemeral((db, change) => {
      if (db.path === server.path && change.kind === 'presence') {
        notices.push(change.row.seq);
      }
    });
    stopStream = onEventStream((path) => {
      if (path === server.path) streamWakes++;
    });
    const fresh = await presenceFor(server, observer, [user, '@hidden:test']);
    assertEquals([...fresh.keys()], [user]);
    assertEquals(fresh.get(user)?.presence, 'online');
    assertEquals(notices, []);
    assertEquals(
      streamWakes,
      0,
      'presence audience read must not publish an event-stream wake',
    );
    Date.now = () => received + 31 * 60 * 1000;
    const expired = await presenceFor(server, observer, [user]);
    assertEquals(expired.get(user)?.presence, 'offline');
    assertEquals(expired.get(user)?.seq, fresh.get(user)!.seq + 1);
    assertEquals(notices, [expired.get(user)!.seq]);
    assertEquals(streamWakes, 0);
    const self = await presenceFor(server, '@self:no-room');
    assertEquals([...self.keys()], ['@self:no-room']);
    assertEquals(self.get('@self:no-room')?.presence, 'offline');
    const departed = await presenceFor(server, observer, [user], async (tx) => {
      await tx.execute(
        "UPDATE memberships SET membership='leave' WHERE user=?",
        [
          user,
        ],
      );
    });
    assertEquals([...departed.keys()], []);
    assertEquals(notices, [expired.get(user)!.seq]);
    assertEquals(streamWakes, 0);
  } finally {
    stopPresence();
    stopStream();
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence freshness upgrade cannot mint receipt evidence for historical online rows', async () => {
  const f = await fixture();
  let store = await f.open(historicalServerSchema(58));
  try {
    const user = '@remote:origin.test';
    await (await store.server()).execute(
      "INSERT INTO presence(user_id,presence,status_msg,last_active_ms,seq) VALUES(?,'online','historical status',?,1)",
      [user, Date.now()],
    );
    await (await store.server()).execute(
      "INSERT INTO counters VALUES('presence',1)",
    );
    await store.close();
    store = await f.open();
    const server = await store.server();
    assertEquals(
      (await server.query(
        'SELECT remote_received_ms FROM presence WHERE user_id=?',
        [user],
      ))[0].remote_received_ms,
      0,
    );
    const row = await getPresence(server, user);
    assertEquals(row.presence, 'offline');
    assertEquals(row.statusMsg, 'historical status');
    assertEquals(row.seq, 2);
  } finally {
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence freshness cannot revive old online activity after a cold store reopen', async () => {
  const f = await fixture();
  let store = await f.open();
  const now = Date.now;
  try {
    const received = now();
    Date.now = () => received;
    const user = '@remote:origin.test';
    await setPresence(await store.server(), user, 'online', 'durable status', {
      remote: true,
    });
    await store.close();
    Date.now = () => received + 31 * 60 * 1000;
    store = await f.open();
    const reopened = await getPresence(await store.server(), user);
    assertEquals(reopened.presence, 'offline');
    assertEquals(reopened.statusMsg, 'durable status');
  } finally {
    Date.now = now;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence freshness does not renew a remote observation while its write is queued', async () => {
  const f = await fixture();
  const store = await f.open();
  const server = await store.server();
  const tx = server.tx.bind(server);
  const clock = Date.now;
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let observation: Promise<void> | undefined;
  try {
    const received = clock();
    Date.now = () => received;
    server.tx = async (fn, options) => {
      admitted.resolve();
      await release.promise;
      return await tx(fn, options);
    };
    observation = setPresence(
      server,
      '@remote:origin.test',
      'online',
      'queued status',
      { remote: true },
    );
    await bounded(admitted.promise);
    Date.now = () => received + 31 * 60 * 1000;
    release.resolve();
    await observation;
    assertEquals(
      await server.query(
        'SELECT presence,status_msg,remote_received_ms FROM presence',
      ),
      [{
        presence: 'offline',
        status_msg: 'queued status',
        remote_received_ms: received,
      }],
    );
  } finally {
    release.resolve();
    server.tx = tx;
    await Promise.allSettled([observation]);
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence transactions do not queue behind a held event writer', async (t) => {
  const f = await fixture();
  const store = await f.open();
  const server = await store.server();
  const local = '@local:local.test';
  const device = { deviceId: 'PHONE', generation: 1 };
  const remote = '@remote:origin.test';
  const syncEntered = Promise.withResolvers<void>();
  const finishSync = Promise.withResolvers<void>();
  const writerEntered = Promise.withResolvers<void>();
  const finishWriter = Promise.withResolvers<void>();
  let sync: Promise<void> | undefined;
  let writer: Promise<void> | undefined;
  const work: Promise<unknown>[] = [];
  const admissionError = new Error('status admission reached');
  const streamChanges: string[] = [];
  const stop = onEventStream((path) => {
    if (path === server.path) streamChanges.push(path);
  });
  try {
    await setPresence(server, remote, 'online', 'keep', {
      remote: true,
    });
    await server.execute(
      'UPDATE presence SET remote_received_ms=0 WHERE user_id=?',
      [remote],
    );
    const syncing = withPresenceSync(server, local, 'online', device, () => {
      syncEntered.resolve();
      return finishSync.promise;
    });
    sync = syncing;
    await bounded(syncEntered.promise);
    streamChanges.length = 0;
    writer = eventStreamTx(server, async () => {
      writerEntered.resolve();
      await finishWriter.promise;
    });
    await bounded(writerEntered.promise);
    const cases: [string, () => Promise<unknown>][] = [
      ['explicit write', () => setPresence(server, local, 'online', 'new')],
      ['source replacement', () =>
        replacePresenceSource(
          server,
          { node: 'edge', incarnation: 'one' },
          [{
            userId: local,
            ...device,
            presence: 'online',
            remainingMs: 30_000,
            lastActiveAgo: 0,
          }],
          () => 0,
          () => Promise.resolve(),
        )],
      ['sync completion', () => {
        finishSync.resolve();
        return syncing;
      }],
      ['read normalizes stale presence', async () => {
        assertEquals((await getPresence(server, remote)).presence, 'offline');
      }],
      ['causal status admission', () =>
        assertRejects(
          () =>
            importPresenceStatus(server, {
              source: 'edge',
              incarnation: 'one',
              sequence: 1,
              operationId: 'unused',
              stream: 'unused',
              semanticKey: 'unused',
              kind: 'presence-status',
              context: [],
              payloadHash: 'unused',
              payload: '{}',
            }, () => Promise.reject(admissionError)),
          Error,
          admissionError.message,
        )],
    ];
    for (const [name, run] of cases) {
      await t.step(name, async () => {
        const result = run();
        work.push(result);
        await bounded(result, 5_000);
      });
    }
    assertEquals(streamChanges, []);
  } finally {
    stop();
    finishWriter.resolve();
    finishSync.resolve();
    await Promise.allSettled([writer, sync, ...work]);
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence freshness rechecks a stale reader after a new authenticated observation', async () => {
  const f = await fixture();
  const store = await f.open();
  const clock = Date.now;
  const sampled = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const server = await store.server();
  const query = server.query.bind(server);
  let read: ReturnType<typeof getPresence> | undefined;
  try {
    const received = clock();
    Date.now = () => received;
    const user = '@remote:origin.test';
    await setPresence(server, user, 'online', 'old', { remote: true });
    Date.now = () => received + 31 * 60 * 1000;
    let hold = true;
    server.query = async (sql, values) => {
      const rows = await query(sql, values);
      if (hold && sql === 'SELECT * FROM presence WHERE user_id=?') {
        hold = false;
        sampled.resolve();
        await release.promise;
      }
      return rows;
    };
    read = getPresence(server, user);
    await sampled.promise;
    await setPresence(server, user, 'online', 'fresh', { remote: true });
    release.resolve();
    const row = await read;
    assertEquals(row.presence, 'online');
    assertEquals(row.statusMsg, 'fresh');
    assertEquals(row.seq, 2);
  } finally {
    release.resolve();
    await read;
    server.query = query;
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});

Deno.test('presence freshness snapshot expiry and its exact cut roll back together before notification', async () => {
  const f = await fixture();
  const store = await f.open();
  const clock = Date.now;
  let stop = () => {};
  try {
    const server = await store.server();
    const received = clock();
    Date.now = () => received;
    const user = '@remote:origin.test';
    await setPresence(server, user, 'online', 'snapshot status', {
      remote: true,
    });
    for (const member of [user, '@viewer:local.test']) {
      await server.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
        member,
        '!presence:origin.test',
        'join',
        '$join',
        1,
      ]);
    }
    Date.now = () => received + 31 * 60 * 1000;
    const notifications: number[] = [];
    stop = onEphemeral((db, change) => {
      if (db.path === server.path && change.kind === 'presence') {
        notifications.push(change.row.seq);
      }
    });
    await assertRejects(
      () =>
        server.tx(async (tx) => {
          const captured = await capturePresence(tx, '@viewer:local.test');
          assertEquals(captured.rows.get(user)?.presence, 'offline');
          throw new Error('held presence snapshot');
        }),
      Error,
      'held presence snapshot',
    );
    const [rolledBack] = await server.query(
      'SELECT presence,seq FROM presence WHERE user_id=?',
      [user],
    );
    assertEquals(rolledBack, { presence: 'online', seq: 1 });
    assertEquals(notifications, []);
    const captured = await server.tx(async (tx) => {
      const presence = await capturePresence(tx, '@viewer:local.test');
      const [counter] = await tx.query(
        "SELECT value FROM counters WHERE name='presence'",
      );
      assertEquals(counter.value, 2);
      return presence;
    });
    assertEquals(captured.rows.get(user)?.seq, 2);
    assertEquals(notifications, []);
    publishPresence(server, captured);
    assertEquals(notifications, [2]);
  } finally {
    stop();
    Date.now = clock;
    await store.close();
    await Deno.remove(f.dir, { recursive: true });
  }
});
