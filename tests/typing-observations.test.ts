import { assertEquals, assertRejects } from '@std/assert';
import { MatrixError } from '#engine/matrix-error.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import {
  captureLocalTyping,
  captureTyping,
  onTypingChange,
  reconcileTyping,
  replaceTypingSource,
  setTyping,
  typingIn,
} from '#engine/typing.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'typing-observations-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  const server = await store.server();
  const room = '!typing-' + crypto.randomUUID() + ':local.test';
  const user = '@local:local.test';
  await server.execute(
    "INSERT INTO memberships(user,room,membership,event,seq) VALUES(?,?,'join','$join',0)",
    [user, room],
  );
  return {
    server,
    room,
    user,
    phone: { deviceId: 'PHONE', generation: 1 },
    desktop: { deviceId: 'DESKTOP', generation: 1 },
    async close() {
      await server.execute(
        "UPDATE memberships SET membership='leave' WHERE room=? AND user=?",
        [room, user],
      );
      await reconcileTyping(server, room);
      await store.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('typing observations: stopping one device preserves another device and aggregate federation signal', async () => {
  const f = await fixture();
  const signals: boolean[] = [];
  const off = onTypingChange((room, user, active) => {
    if (room === f.room && user === f.user) signals.push(active);
  });
  try {
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    await setTyping(f.server, f.room, f.user, true, 30_000, f.desktop);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    assertEquals(signals, [true, true, true]);
    await setTyping(f.server, f.room, f.user, false, undefined, f.desktop);
    assertEquals(typingIn(f.room).userIds, []);
    assertEquals(signals.at(-1), false);
  } finally {
    off();
    await f.close();
  }
});

Deno.test('typing observations: device expiries are independent and departures clear the whole union', async () => {
  const f = await fixture();
  const clock = Date.now;
  try {
    const start = clock();
    Date.now = () => start;
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    await setTyping(f.server, f.room, f.user, true, 60_000, f.desktop);
    Date.now = () => start + 31_000;
    assertEquals(typingIn(f.room).userIds, [f.user]);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    await f.server.execute(
      "UPDATE memberships SET membership='leave' WHERE room=? AND user=?",
      [f.room, f.user],
    );
    await reconcileTyping(f.server, f.room);
    assertEquals(typingIn(f.room).userIds, []);
    assertEquals(
      await setTyping(f.server, f.room, f.user, true, 30_000, f.desktop),
      false,
    );
  } finally {
    Date.now = clock;
    await f.close();
  }
});

Deno.test('typing observations: retired device generation cannot clear its replacement', async () => {
  const f = await fixture();
  try {
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    const replacement = { deviceId: f.phone.deviceId, generation: 2 };
    await setTyping(f.server, f.room, f.user, true, 30_000, replacement);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    await setTyping(f.server, f.room, f.user, false, undefined, replacement);
    assertEquals(typingIn(f.room).userIds, []);
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    assertEquals(typingIn(f.room).userIds, []);
  } finally {
    await f.close();
  }
});

Deno.test('typing observations: one node cannot stop another node with the same device ID', async () => {
  const f = await fixture();
  try {
    const edge = { ...f.phone, source: 'edge-a' };
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    await setTyping(f.server, f.room, f.user, true, 30_000, edge);
    await setTyping(f.server, f.room, f.user, false, undefined, edge);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    assertEquals(typingIn(f.room).userIds, []);
  } finally {
    await f.close();
  }
});

Deno.test('typing observations: device generations are fenced within their authenticated node, not across nodes', async () => {
  const f = await fixture();
  try {
    const local = { ...f.phone, generation: 10 };
    const edge = { ...f.phone, source: 'edge-a' };
    await setTyping(f.server, f.room, f.user, true, 30_000, local);
    await setTyping(f.server, f.room, f.user, true, 30_000, edge);
    await setTyping(f.server, f.room, f.user, false, undefined, local);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    await setTyping(f.server, f.room, f.user, false, undefined, edge);
    assertEquals(typingIn(f.room).userIds, []);
  } finally {
    await f.close();
  }
});

Deno.test('typing live source: capture retains original lifetime and never re-exports an imported observation', async () => {
  const f = await fixture();
  const clock = Date.now;
  let now = clock();
  Date.now = () => now;
  const signals: boolean[] = [];
  const off = onTypingChange((room, user, active) => {
    if (room === f.room && user === f.user) signals.push(active);
  });
  try {
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    now += 10_000;
    const values = await captureLocalTyping(f.server, [f.room]);
    assertEquals(values, [{
      roomId: f.room,
      userId: f.user,
      deviceId: f.phone.deviceId,
      generation: 1,
      membership: '$join',
      remainingMs: 20_000,
    }]);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => 5_000,
      async () => {},
    );
    assertEquals(captureTyping([f.room]).rooms.get(f.room)?.userIds, [f.user]);
    assertEquals(await captureLocalTyping(f.server, [f.room]), []);
    const cut = captureTyping([f.room]);
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => 5_000,
      async () => {},
    );
    assertEquals(
      captureTyping([f.room]).seq,
      cut.seq,
      'unchanged union is not new typing news',
    );
    now += 15_001;
    assertEquals(typingIn(f.room).userIds, []);
    assertEquals(signals, [true, false, true]);
  } finally {
    off();
    Date.now = clock;
    await f.close();
  }
});

Deno.test('typing live source: delayed receipt and repeated receipt cannot renew an expired source lifetime', async () => {
  const f = await fixture();
  const clock = Date.now;
  const start = clock();
  let now = start;
  Date.now = () => now;
  try {
    await setTyping(f.server, f.room, f.user, true, 10_000, f.phone);
    const values = await captureLocalTyping(f.server, [f.room]);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    now += 3_000;
    const elapsed = () => now - start;
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      elapsed,
      async () => {},
    );
    assertEquals(typingIn(f.room).userIds, [f.user]);
    now += 8_000;
    assertEquals(typingIn(f.room).userIds, []);
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      elapsed,
      async () => {},
    );
    assertEquals(typingIn(f.room).userIds, []);
    await replaceTypingSource(
      f.server,
      'edge-b',
      values,
      elapsed,
      async () => {},
    );
    assertEquals(
      typingIn(f.room).userIds,
      [],
      'already delayed first receipt stays expired',
    );
  } finally {
    Date.now = clock;
    await f.close();
  }
});

Deno.test('typing live source: admission waits age the snapshot and failed admission cannot clear or publish', async () => {
  const f = await fixture();
  const clock = Date.now;
  const start = clock();
  let now = start;
  Date.now = () => now;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let importing: Promise<void> | undefined;
  try {
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    const values = await captureLocalTyping(f.server, [f.room]);
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => 0,
      async () => {},
    );
    const cut = captureTyping([f.room]);
    await assertRejects(
      () =>
        replaceTypingSource(f.server, 'edge-a', [], () => 0, () => {
          throw new MatrixError(
            503,
            'M_UNAVAILABLE',
            'held account/room admission',
          );
        }),
      MatrixError,
    );
    assertEquals(captureTyping([f.room]).seq, cut.seq);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    importing = replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => now - start,
      async () => {
        entered.resolve();
        await release.promise;
      },
    );
    await entered.promise;
    now += 31_000;
    release.resolve();
    await importing;
    assertEquals(typingIn(f.room).userIds, []);
  } finally {
    release.resolve();
    await importing;
    Date.now = clock;
    await f.close();
  }
});

Deno.test('typing live source: source replacement preserves local/other nodes and departure fences an older membership', async () => {
  const f = await fixture();
  try {
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    const values = await captureLocalTyping(f.server, [f.room]);
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => 0,
      async () => {},
    );
    await replaceTypingSource(
      f.server,
      'edge-b',
      values,
      () => 0,
      async () => {},
    );
    await replaceTypingSource(f.server, 'edge-a', [], () => 0, async () => {});
    await setTyping(f.server, f.room, f.user, false, undefined, f.phone);
    assertEquals(typingIn(f.room).userIds, [f.user]);
    await replaceTypingSource(f.server, 'edge-b', [], () => 0, async () => {});
    assertEquals(typingIn(f.room).userIds, []);
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => 0,
      async () => {},
    );
    await f.server.execute(
      "UPDATE memberships SET membership='leave' WHERE room=?",
      [f.room],
    );
    await reconcileTyping(f.server, f.room);
    assertEquals(typingIn(f.room).userIds, []);
    await f.server.execute(
      "UPDATE memberships SET membership='join',event='$new-join' WHERE room=?",
      [f.room],
    );
    await replaceTypingSource(
      f.server,
      'edge-a',
      values,
      () => 0,
      async () => {},
    );
    assertEquals(
      typingIn(f.room).userIds,
      [],
      'an old join observation cannot revive after leave/rejoin',
    );
  } finally {
    await f.close();
  }
});

Deno.test('typing live source: malformed snapshots cannot replace a source or mutate the public cut', async () => {
  const f = await fixture();
  try {
    await setTyping(f.server, f.room, f.user, true, 30_000, f.phone);
    const values = await captureLocalTyping(f.server, [f.room]);
    const cut = captureTyping([f.room]);
    for (
      const [source, input] of [
        ['', values],
        ['edge-a', [...values, ...values]],
        ['edge-a', values.map((value) => ({ ...value, remainingMs: -1 }))],
      ] as const
    ) {
      await assertRejects(
        () =>
          replaceTypingSource(f.server, source, input, () => 0, async () => {}),
        MatrixError,
      );
      assertEquals(captureTyping([f.room]).seq, cut.seq);
      assertEquals(typingIn(f.room).userIds, [f.user]);
    }
  } finally {
    await f.close();
  }
});
