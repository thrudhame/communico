import { assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { theApp } from '#engine/app.ts';
import { openRoom } from '#engine/room/index.ts';
import { buildInTx } from '#engine/room/build.ts';
import { deviceIdentity, transactionSubmission } from '#engine/tenant/txns.ts';

const suite = httpSuite('HTTP E6 encryption policy');
const reset = () =>
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: false,
      allowunencryptedjoining: true,
      allowunencryptedmessages: false,
    },
  });
async function call(
  token: string,
  path: string,
  body?: unknown,
  method = 'POST',
  status = 200,
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: body === undefined ? 'GET' : method,
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(response.status, status, await response.clone().text());
  return await response.json();
}
suite.test('default creation publishes encryption and refuses plaintext messages', async () => {
  reset();
  const user = await suite.registerTestUser('policy-default', 'pw');
  const call = (path: string, body?: unknown, method = 'POST') =>
    suite.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method: body === undefined ? 'GET' : method,
        headers: { Authorization: 'Bearer ' + user.access_token },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  const created = await call('createRoom', {});
  assertEquals(created.status, 200, await created.clone().text());
  const room = encodeURIComponent((await created.json()).room_id);
  const state = await call('rooms/' + room + '/state/m.room.encryption/');
  assertEquals(state.status, 200, await state.clone().text());
  assertEquals((await state.json()).algorithm, 'm.megolm.v1.aes-sha2');
  const plain = await call('rooms/' + room + '/send/m.room.message/plain', {
    msgtype: 'm.text',
    body: 'must not leave this server',
  }, 'PUT');
  assertEquals(plain.status, 400, await plain.clone().text());
  const cipher = await call('rooms/' + room + '/send/m.room.encrypted/cipher', {
    algorithm: 'm.megolm.v1.aes-sha2',
    ciphertext: 'opaque',
  }, 'PUT');
  assertEquals(cipher.status, 200, await cipher.clone().text());
});

suite.test('permissive encryption state has the same contract at creation, ordinary writes and upgrade', async () => {
  const a = await suite.registerTestUser('policy-initial-parity', 'pw');
  const token = a.access_token!;
  try {
    for (const content of [{}, { algorithm: 'unknown' }]) {
      setConfigForTests({
        encryption: {
          allowunencryptedcreation: true,
          allowunencryptedjoining: true,
        },
      });
      const made = await call(token, 'createRoom', {
        initial_state: [{ type: 'm.room.encryption', state_key: '', content }],
      });
      const room = encodeURIComponent(made.room_id);
      assertEquals(
        await call(token, 'rooms/' + room + '/state/m.room.encryption/'),
        content,
      );
      await call(
        token,
        'rooms/' + room + '/state/m.room.encryption/',
        content,
        'PUT',
      );
      const upgraded = await call(token, 'rooms/' + room + '/upgrade', {
        new_version: '12',
      });
      assertEquals(
        await call(
          token,
          'rooms/' + encodeURIComponent(upgraded.replacement_room) +
            '/state/m.room.encryption/',
        ),
        content,
      );
      setConfigForTests({ encryption: { allowunencryptedcreation: false } });
      await call(
        token,
        'createRoom',
        { initial_state: [{ type: 'm.room.encryption', content }] },
        'POST',
        400,
      );
    }
  } finally {
    reset();
  }
});

suite.test('creation preserves supported settings, rejects contradictory plans atomically, exempts only spaces', async () => {
  reset();
  const a = await suite.registerTestUser('policy-create', 'pw');
  const t = a.access_token!;
  const before = await call(t, 'joined_rooms');
  for (
    const initial_state of [
      [{ type: 'm.room.encryption', content: {} }],
      [{ type: 'm.room.encryption', content: { algorithm: 'unknown' } }],
      [{
        type: 'm.room.encryption',
        state_key: 'bypass',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }],
      [{
        type: 'm.room.encryption',
        content: { algorithm: 'm.megolm.v1.aes-sha2' },
      }, { type: 'm.room.encryption', content: {} }],
      [{
        type: 'm.room.encryption',
        content: { algorithm: 'm.megolm.v1.aes-sha2', rotation_period_ms: -1 },
      }],
    ]
  ) await call(t, 'createRoom', { initial_state }, 'POST', 400);
  await call(
    t,
    'createRoom',
    {
      power_level_content_override: {
        events: { 'm.room.encryption': 101 },
      },
    },
    'POST',
    400,
  );
  await call(
    t,
    'createRoom',
    {
      initial_state: [{
        type: 'm.room.power_levels',
        content: {
          users: { [a.user_id]: 0 },
          state_default: 50,
        },
      }],
    },
    'POST',
    400,
  );
  assertEquals(await call(t, 'joined_rooms'), before);
  const content = {
    algorithm: 'm.megolm.v1.aes-sha2',
    rotation_period_ms: 42,
    rotation_period_msgs: 5,
  };
  const explicit = await call(t, 'createRoom', {
    initial_state: [{ type: 'm.room.encryption', content }],
  });
  assertEquals(
    await call(
      t,
      'rooms/' + encodeURIComponent(explicit.room_id) +
        '/state/m.room.encryption/',
    ),
    content,
  );
  const space = await call(t, 'createRoom', {
    creation_content: { type: 'm.space' },
  });
  await call(
    t,
    'rooms/' + encodeURIComponent(space.room_id) + '/state/m.room.encryption/',
    undefined,
    'GET',
    404,
  );
  const fakeNotice = await call(t, 'createRoom', {
    creation_content: { type: 'm.server_notice' },
    server_notice: true,
  });
  assertEquals(
    (await call(
      t,
      'rooms/' + encodeURIComponent(fakeNotice.room_id) +
        '/state/m.room.encryption/',
    )).algorithm,
    content.algorithm,
  );
});

suite.test('locked authoring protects lifecycle, finite verification exceptions and refused transaction reuse', async () => {
  reset();
  const a = await suite.registerTestUser('policy-lifecycle', 'pw');
  const t = a.access_token!;
  const made = await call(t, 'createRoom', {});
  const room = 'rooms/' + encodeURIComponent(made.room_id);
  const encryption = (await call(t, room + '/state')).find((
    e: { type: string },
  ) => e.type === 'm.room.encryption');
  await call(t, room + '/state/m.room.encryption/', {}, 'PUT', 400);
  await call(
    t,
    room + '/redact/' + encodeURIComponent(encryption.event_id) + '/downgrade',
    {},
    'PUT',
    400,
  );
  await call(t, room + '/state/m.room.topic/', {
    topic: 'state stays plaintext',
  }, 'PUT');
  const cipher = await call(t, room + '/send/m.room.encrypted/opaque', {
    ciphertext: 'opaque',
  }, 'PUT');
  await call(
    t,
    room + '/redact/' + encodeURIComponent(cipher.event_id) + '/normal',
    {},
    'PUT',
  );
  for (
    const suffix of ['ready', 'start', 'accept', 'key', 'mac', 'done', 'cancel']
  ) {
    await call(
      t,
      room + '/send/m.key.verification.' + suffix + '/' + suffix,
      {},
      'PUT',
    );
  }
  await call(t, room + '/send/m.room.message/request', {
    msgtype: 'm.key.verification.request',
    body: 'verification',
  }, 'PUT');
  await call(
    t,
    room + '/send/m.key.verification.custom/custom',
    {},
    'PUT',
    400,
  );
  await call(
    t,
    room + '/send/m.room.message/retry',
    { msgtype: 'm.text', body: 'rejected original' },
    'PUT',
    400,
  );
  setConfigForTests({ encryption: { allowunencryptedmessages: true } });
  const allowed = await call(t, room + '/send/m.room.message/retry', {
    msgtype: 'm.text',
    body: 'accepted replacement',
  }, 'PUT');
  assertEquals(
    (await call(t, room + '/event/' + encodeURIComponent(allowed.event_id)))
      .content.body,
    'accepted replacement',
  );
  setConfigForTests({ encryption: { allowunencryptedcreation: true } });
  await call(t, room + '/state/m.room.encryption/', {}, 'PUT');
  reset();
});

suite.test('all create/join/message combinations and Element flags match the independent controls', async () => {
  const a = await suite.registerTestUser('policy-combo-a', 'pw');
  const b = await suite.registerTestUser('policy-combo-b', 'pw');
  for (const creation of [false, true]) {
    for (const joining of [false, true]) {
      for (const messages of [false, true]) {
        setConfigForTests({
          encryption: {
            allowunencryptedcreation: creation,
            allowunencryptedjoining: joining,
            allowunencryptedmessages: messages,
          },
        });
        assertEquals(config().encryption.allowunencryptedjoining, joining);
        const versions = await suite.matrix(
          new Request('http://x/_matrix/client/versions'),
        );
        const flags = (await versions.json()).unstable_features;
        // This matrix owns the encryption-policy namespace. The complete
        // discovery response is asserted independently in http-client-data.
        const encryptionFlags = Object.fromEntries(
          Object.entries(flags).filter(([name]) =>
            name.startsWith('io.element.e2ee_forced.')
          ),
        );
        assertEquals(encryptionFlags, {
          'io.element.e2ee_forced.public': !creation,
          'io.element.e2ee_forced.private': !creation,
          'io.element.e2ee_forced.trusted_private': !creation,
        });
        const made = await call(a.access_token!, 'createRoom', {
          preset: 'public_chat',
        });
        const id = encodeURIComponent(made.room_id);
        await call(
          b.access_token!,
          'join/' + id,
          {},
          'POST',
          creation && !joining ? 400 : 200,
        );
        await call(
          a.access_token!,
          'rooms/' + id + '/send/m.room.message/combination',
          {
            msgtype: 'm.text',
            body: 'policy probe',
          },
          'PUT',
          !creation && !messages ? 400 : 200,
        );
        if (creation && !joining) {
          await call(
            a.access_token!,
            'rooms/' + id + '/state/m.room.encryption/',
            { algorithm: 'm.megolm.v1.aes-sha2' },
            'PUT',
          );
          await call(b.access_token!, 'rooms/' + id + '/join', {});
        }
      }
    }
  }
  reset();
});

suite.test('persisted prepared plaintext is rechecked after encryption; completed receipts still replay', async () => {
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: true,
      allowunencryptedjoining: true,
      allowunencryptedmessages: true,
    },
  });
  const a = await suite.registerTestUser('policy-prepared', 'pw');
  const made = await call(a.access_token!, 'createRoom', {});
  const room = await openRoom(theApp().store, made.room_id);
  const accepted = await call(
    a.access_token!,
    'rooms/' + encodeURIComponent(room.id) + '/send/m.room.message/accepted',
    { body: 'already committed' },
    'PUT',
  );
  const device = await deviceIdentity(
    theApp().tenant,
    'policy-prepared',
    a.device_id!,
  );
  const endpoint = {
    kind: 'send' as const,
    roomId: room.id,
    eventType: 'm.room.message',
  };
  const command = transactionSubmission(
    theApp().tenant,
    device,
    endpoint,
    'prepared',
  )!;
  const pdu = await room.tx((tx) =>
    buildInTx(tx, room.id, {
      type: 'm.room.message',
      sender: a.user_id,
      content: { body: 'prepared before encryption' },
    }, theApp().tenant.signer())
  );
  await command.prepare(pdu);
  reset();
  await call(
    a.access_token!,
    'rooms/' + encodeURIComponent(room.id) + '/state/m.room.encryption/',
    { algorithm: 'm.megolm.v1.aes-sha2' },
    'PUT',
  );
  await call(
    a.access_token!,
    'rooms/' + encodeURIComponent(room.id) + '/send/m.room.message/prepared',
    { body: 'retry cannot bypass current policy' },
    'PUT',
    400,
  );
  assertEquals(
    await room.tx((tx) => tx.events.get(String(pdu.event_id))),
    null,
  );
  assertEquals(
    (await command.lookup())!.pdu!.content.body,
    'prepared before encryption',
    'refusal must preserve the pending command',
  );
  assertEquals(
    await call(
      a.access_token!,
      'rooms/' + encodeURIComponent(room.id) + '/send/m.room.message/accepted',
      { body: 'ignored retry' },
      'PUT',
    ),
    accepted,
  );
});

suite.test('local upgrades apply forced encryption and preserve existing rotation settings', async () => {
  const a = await suite.registerTestUser('policy-upgrade', 'pw');
  for (const encrypted of [false, true]) {
    setConfigForTests({
      encryption: {
        allowunencryptedcreation: true,
        allowunencryptedjoining: true,
        allowunencryptedmessages: true,
      },
    });
    const content = {
      algorithm: 'm.megolm.v1.aes-sha2',
      rotation_period_msgs: 12,
    };
    const made = await call(
      a.access_token!,
      'createRoom',
      encrypted
        ? { initial_state: [{ type: 'm.room.encryption', content }] }
        : {},
    );
    reset();
    const replacement = await call(
      a.access_token!,
      'rooms/' + encodeURIComponent(made.room_id) + '/upgrade',
      { new_version: '12' },
    );
    const state = await call(
      a.access_token!,
      'rooms/' + encodeURIComponent(replacement.replacement_room) +
        '/state/m.room.encryption/',
    );
    assertEquals(
      state,
      encrypted ? content : { algorithm: 'm.megolm.v1.aes-sha2' },
    );
  }
  reset();
});
