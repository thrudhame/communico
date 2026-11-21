import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { acceptIngressEdu } from '#engine/facade/ingress-edus.ts';
import { decodeToDevice } from '#engine/federation/todevice.ts';
import {
  eduState,
  PermanentEduRefusal,
  ReliableEduError,
} from '#engine/federation/edus.ts';
import { openStore } from '#engine/store/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { getPresence } from '#engine/server/ephemeral.ts';
import { setTyping, typingIn } from '#engine/typing.ts';

Deno.test('F2 fresh federation activity reaches the ordinary membership-checked owners without local devices', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'fresh-federation-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  const room = '!fresh-federation:remote.test';
  const user = '@alice:remote.test';
  try {
    const server = await store.server();
    for (const member of [user, '@bob:home.test']) {
      await server.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
        member,
        room,
        'join',
        '$join',
        1,
      ]);
    }
    const edus = eduState(server, self, store);
    const presence = {
      edu_type: 'm.presence',
      content: {
        push: [{
          user_id: user,
          presence: 'online',
          last_active_ago: 90 * 60_000,
        }],
      },
    };
    await acceptIngressEdu(origin, self, presence, edus, 'f2');
    assertEquals((await getPresence(server, user)).presence, 'online');
    await acceptIngressEdu(
      origin,
      self,
      {
        ...presence,
        content: {
          push: [{ user_id: '@forged:elsewhere.test', presence: 'online' }],
        },
      },
      edus,
      'f2',
    );
    assertEquals(
      (await getPresence(server, '@forged:elsewhere.test')).presence,
      'offline',
    );
    // No shared room means no remote presence, even for an authentic origin.
    await acceptIngressEdu(
      origin,
      self,
      {
        ...presence,
        content: {
          push: [{ user_id: '@unjoined:remote.test', presence: 'online' }],
        },
      },
      edus,
      'f2',
    );
    assertEquals(
      (await getPresence(server, '@unjoined:remote.test')).presence,
      'offline',
    );
    const typing = {
      edu_type: 'm.typing',
      content: { room_id: room, user_id: user, typing: true },
    };
    await acceptIngressEdu(origin, self, typing, edus, 'f2');
    assertEquals(typingIn(room).userIds, [user]);
    await acceptIngressEdu(
      origin,
      self,
      { ...typing, content: { ...typing.content, typing: false } },
      edus,
      'f2',
    );
    assertEquals(typingIn(room).userIds, []);
    await acceptIngressEdu(
      origin,
      self,
      {
        ...typing,
        content: { ...typing.content, user_id: '@unjoined:remote.test' },
      },
      edus,
      'f2',
    );
    assertEquals(typingIn(room).userIds, []);
  } finally {
    await setTyping(await store.server(), room, user, false);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

const origin = 'remote.test', self = 'home.test';
const direct = {
  sender: '@alice:remote.test',
  type: 'm.room.encrypted',
  message_id: 'one',
  messages: {
    '@bob:home.test': { '*': { ciphertext: 'kept', algorithm: 'test' } },
  },
};
const unused = {
  dispatch: () => Promise.reject(new Error('must not deliver at facade')),
};

Deno.test('F2 delayed federation activity keeps its original receipt expiry and cannot replace a newer observation', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'federation-receipt-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  const clock = Date.now;
  const received = clock();
  const user = '@alice:remote.test', room = '!receipt:remote.test';
  try {
    const server = await store.server();
    for (const member of [user, '@bob:home.test']) {
      await server.execute('INSERT INTO memberships VALUES(?,?,?,?,?)', [
        member,
        room,
        'join',
        '$join',
        1,
      ]);
    }
    const edus = eduState(server, self, store);
    const presence = {
      edu_type: 'm.presence',
      content: {
        push: [{
          user_id: user,
          presence: 'online',
          status_msg: 'original status',
          last_active_ago: 0,
        }],
      },
    };
    const typing = {
      edu_type: 'm.typing',
      content: { room_id: room, user_id: user, typing: true },
    };
    Date.now = () => received + 29_000;
    await acceptIngressEdu(
      origin,
      self,
      typing,
      edus,
      'f2',
      undefined,
      received,
    );
    assertEquals(typingIn(room).userIds, [user]);
    Date.now = () => received + 30_001;
    assertEquals(typingIn(room).userIds, []);
    await acceptIngressEdu(
      origin,
      self,
      typing,
      edus,
      'f2',
      undefined,
      received,
    );
    assertEquals(
      typingIn(room).userIds,
      [],
      'retry is not a fresh typing observation',
    );
    Date.now = () => received + 29 * 60_000;
    await acceptIngressEdu(
      origin,
      self,
      presence,
      edus,
      'f2',
      undefined,
      received,
    );
    assertEquals((await getPresence(server, user)).presence, 'online');
    assertEquals((await getPresence(server, user)).lastActiveMs, received);
    Date.now = () => received + 31 * 60_000;
    assertEquals((await getPresence(server, user)).presence, 'offline');
    await acceptIngressEdu(
      origin,
      self,
      presence,
      edus,
      'f2',
      undefined,
      received,
    );
    assertEquals(
      (await getPresence(server, user)).presence,
      'offline',
      'retry cannot renew remote online',
    );
    const newer = Date.now();
    await acceptIngressEdu(
      origin,
      self,
      presence,
      edus,
      'f2',
      undefined,
      newer,
    );
    await acceptIngressEdu(origin, self, typing, edus, 'f2', undefined, newer);
    await acceptIngressEdu(
      origin,
      self,
      {
        ...presence,
        content: { push: [{ user_id: user, presence: 'offline' }] },
      },
      edus,
      'f2',
      undefined,
      received,
    );
    await acceptIngressEdu(
      origin,
      self,
      { ...typing, content: { ...typing.content, typing: false } },
      edus,
      'f2',
      undefined,
      received,
    );
    assertEquals((await getPresence(server, user)).presence, 'online');
    assertEquals(typingIn(room).userIds, [user]);
    // A caller queued behind a writer still consumes the ORIGINAL receipt time.
    let entered!: () => void, release!: () => void;
    const inside = new Promise<void>((resolve) => entered = resolve);
    const gate = new Promise<void>((resolve) => release = resolve);
    const held = server.tx(async () => {
      entered();
      await gate;
    });
    await inside;
    const pending = acceptIngressEdu(
      origin,
      self,
      presence,
      edus,
      'f2',
      undefined,
      newer,
    );
    Date.now = () => newer + 31 * 60_000;
    release();
    await held;
    await pending;
    assertEquals((await getPresence(server, user)).presence, 'offline');
  } finally {
    Date.now = clock;
    await setTyping(await store.server(), room, user, false);
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('retained F2 ingress requires its handler instead of checkpointing F1 unknown-type ignore', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'retained-f2-edu-' });
  const store = await openStore({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  }, { schemas: { server: serverSchema } });
  try {
    const edus = eduState(await store.server(), self, store);
    const raw = {
      edu_type: 'm.device_list_update',
      content: {
        user_id: '@alice:remote.test',
        device_id: 'A',
        stream_id: 1,
        prev_id: [],
        deleted: true,
      },
    };
    await assertRejects(
      () => acceptIngressEdu(origin, self, raw, edus, 'f2'),
      ReliableEduError,
    );
    // Ordinary unknown EDUs and F1 mailbox-only retention stay unchanged.
    await edus.dispatch(origin, raw);
    assertEquals(
      (await acceptIngressEdu(origin, self, raw, edus, 'f1')).kind,
      'retained',
    );
    const applied: unknown[] = [];
    edus.register('m.device_list_update', (from, content) => {
      applied.push([from, content]);
      return Promise.resolve();
    }, true);
    assertEquals(
      (await acceptIngressEdu(origin, self, raw, edus, 'f2')).kind,
      'retained',
    );
    assertEquals(
      applied,
      [[origin, raw.content]],
      'retry completes only after the consumer actually applies the update',
    );
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('F1 to-device admission shares home validation but never expands facade targets', async () => {
  assertEquals(decodeToDevice(origin, self, direct).id, 'one');
  assertEquals(
    await acceptIngressEdu(origin, self, {
      edu_type: 'm.direct_to_device',
      content: direct,
    }, unused),
    { kind: 'retained', type: 'm.direct_to_device', policy: 'legacy' },
  );
  for (
    const patch of [{ sender: '@fake:other.test' }, { message_id: '' }, {
      type: 7,
    }, { messages: null }]
  ) {
    const invalid = { ...direct, ...patch };
    assertThrows(
      () => decodeToDevice(origin, self, invalid),
      PermanentEduRefusal,
    );
    assertEquals(
      (await acceptIngressEdu(origin, self, {
        edu_type: 'm.direct_to_device',
        content: invalid,
      }, unused)).kind,
      'refused',
    );
  }
});

Deno.test('F1 keeps reliable device updates, rejects malformed shapes and ignores foreign users', async () => {
  const device = {
    user_id: '@alice:remote.test',
    device_id: 'A',
    stream_id: 1,
    prev_id: [],
    deleted: true,
  };
  assertEquals(
    (await acceptIngressEdu(origin, self, {
      edu_type: 'm.device_list_update',
      content: device,
    }, unused)).kind,
    'retained',
  );
  assertEquals(
    (await acceptIngressEdu(origin, self, {
      edu_type: 'm.device_list_update',
      content: { ...device, stream_id: {} },
    }, unused)).kind,
    'refused',
  );
  for (const type of ['m.device_list_update', 'm.signing_key_update']) {
    assertEquals(
      (await acceptIngressEdu(origin, self, {
        edu_type: type,
        content: { user_id: '@fake:elsewhere.test' },
      }, unused)).kind,
      'ignored',
    );
  }
  assertEquals(
    (await acceptIngressEdu(origin, self, {
      edu_type: 'm.signing_key_update',
      content: { user_id: '@alice:remote.test', master_key: {} },
    }, unused)).kind,
    'refused',
  );
});

Deno.test('F1 explicitly expires volatile activity and delegates receipt marks without swallowing storage errors', async () => {
  for (const type of ['m.typing', 'm.presence']) {
    assertEquals(
      await acceptIngressEdu(
        origin,
        self,
        { edu_type: type, content: {} },
        unused,
      ),
      { kind: 'expired', type },
    );
  }
  assertEquals(
    await acceptIngressEdu(origin, self, {
      edu_type: 'unknown.custom',
      content: {},
    }, unused),
    { kind: 'ignored', type: 'unknown.custom' },
  );
  let calls = 0;
  const receipt = { edu_type: 'm.receipt', content: {} };
  assertEquals(
    await acceptIngressEdu(origin, self, receipt, {
      dispatch: () => {
        calls++;
        return Promise.resolve();
      },
    }),
    { kind: 'retained', type: 'm.receipt' },
  );
  assertEquals(calls, 1);
  await assertRejects(
    () => acceptIngressEdu(origin, self, receipt, unused),
    Error,
    'must not deliver at facade',
  );
});

Deno.test('F2 device ingress delivers validated evidence locally but preserves F1 and separate to-device ownership', async () => {
  const device = {
    user_id: '@alice:remote.test',
    device_id: 'A',
    stream_id: 1,
    prev_id: [],
    deleted: true,
  };
  const signing = { user_id: '@alice:remote.test' };
  const calls: unknown[] = [];
  const edus = {
    dispatch: (from: string, raw: unknown) => {
      calls.push([from, raw]);
      return Promise.resolve();
    },
  };
  for (
    const [type, content] of [
      ['m.device_list_update', device],
      ['m.signing_key_update', signing],
    ] as const
  ) {
    const raw = { edu_type: type, content };
    assertEquals(await acceptIngressEdu(origin, self, raw, edus, 'f2'), {
      kind: 'retained',
      type,
    });
    assertEquals(calls.at(-1), [origin, raw]);
    const before = calls.length;
    await acceptIngressEdu(origin, self, raw, edus, 'f1');
    for (const user_id of ['@fake:elsewhere.test', '@local:home.test']) {
      assertEquals(
        (await acceptIngressEdu(
          origin,
          self,
          { ...raw, content: { ...content, user_id } },
          edus,
          'f2',
        )).kind,
        'ignored',
      );
    }
    assertEquals(calls.length, before);
    await assertRejects(
      () => acceptIngressEdu(origin, self, raw, unused, 'f2'),
      Error,
      'must not deliver',
    );
    await assertRejects(() =>
      acceptIngressEdu(origin, self, raw, {
        dispatch: () =>
          Promise.reject(new ReliableEduError(new Error('disk full'))),
      }, 'f2'), ReliableEduError);
  }
  assertEquals(
    (await acceptIngressEdu(
      origin,
      self,
      {
        edu_type: 'm.device_list_update',
        content: { ...device, stream_id: {} },
      },
      unused,
      'f2',
    )).kind,
    'refused',
  );
  assertEquals(
    (await acceptIngressEdu(
      origin,
      self,
      {
        edu_type: 'm.signing_key_update',
        content: { ...signing, master_key: {} },
      },
      unused,
      'f2',
    )).kind,
    'refused',
  );
  await assertRejects(
    () =>
      acceptIngressEdu(
        origin,
        self,
        {
          edu_type: 'm.direct_to_device',
          content: direct,
        },
        unused,
        'f2',
      ),
    Error,
    'to-device owner unavailable',
  );
});
