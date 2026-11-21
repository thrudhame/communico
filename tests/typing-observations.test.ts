import { assertEquals } from '@std/assert';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import {
  onTypingChange,
  reconcileTyping,
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
