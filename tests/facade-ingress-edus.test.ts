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
