import { assertEquals, assertRejects, assertThrows } from '@std/assert';
import { acceptIngressEdu } from '#engine/facade/ingress-edus.ts';
import { decodeToDevice } from '#engine/federation/todevice.ts';
import { PermanentEduRefusal } from '#engine/federation/edus.ts';

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

Deno.test('F1 to-device admission shares home validation but never expands facade targets', async () => {
  assertEquals(decodeToDevice(origin, self, direct).id, 'one');
  assertEquals(
    await acceptIngressEdu(origin, self, {
      edu_type: 'm.direct_to_device',
      content: direct,
    }, unused),
    { kind: 'retained', type: 'm.direct_to_device' },
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
