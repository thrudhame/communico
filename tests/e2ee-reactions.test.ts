import { assertEquals, assertRejects } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { buildInTx } from '#engine/room/build.ts';
import { openRoom } from '#engine/room/index.ts';
import { ingestLocal, sendLocal } from '#engine/room/ingest.ts';
import { deviceIdentity, transactionSubmission } from '#engine/tenant/txns.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('B1 reaction encryption contract across local writers');
function policy(messages: boolean, reactions: boolean) {
  setConfigForTests({
    encryption: {
      allowunencryptedcreation: false,
      allowunencryptedmessages: messages,
      allowunencryptedreactions: reactions,
    },
    delayedevents: { maxdelayms: 60000 },
  });
}
const relation = (eventId: string, key: unknown = 'reaction') => ({
  rel_type: 'm.annotation',
  event_id: eventId,
  key,
});
const contentCases = (
  eventId: string,
): [string, Record<string, unknown>, boolean][] => [
  ['standard', { 'm.relates_to': relation(eventId) }, true],
  ['empty key', { 'm.relates_to': relation(eventId, '') }, true],
  [
    'arbitrary key',
    { 'm.relates_to': relation(eventId, 'text '.repeat(300)) },
    true,
  ],
  ['body', { 'm.relates_to': relation(eventId), body: 'plaintext' }, false],
  ['extension', {
    'm.relates_to': relation(eventId),
    'org.example.extra': 'plain',
  }, false],
  ['nested extension', {
    'm.relates_to': { ...relation(eventId), 'org.example.extra': {} },
  }, false],
  ['wrong relation', {
    'm.relates_to': { ...relation(eventId), rel_type: 'm.reference' },
  }, false],
  ['number key', { 'm.relates_to': relation(eventId, 1) }, false],
  [
    'object key',
    { 'm.relates_to': relation(eventId, { body: 'plain' }) },
    false,
  ],
  ['null key', { 'm.relates_to': relation(eventId, null) }, false],
  [
    'number target',
    { 'm.relates_to': { ...relation(eventId), event_id: 1 } },
    false,
  ],
  [
    'number relation',
    { 'm.relates_to': { ...relation(eventId), rel_type: 1 } },
    false,
  ],
  ['missing key', {
    'm.relates_to': { rel_type: 'm.annotation', event_id: eventId },
  }, false],
  ['missing relation', {}, false],
  ['null relation', { 'm.relates_to': null }, false],
  ['array relation', { 'm.relates_to': [relation(eventId)] }, false],
];

async function call(
  token: string,
  path: string,
  body?: unknown,
  status = 200,
  version = 'v3',
) {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/' + version + '/' + path, {
      method: body === undefined ? 'GET' : 'PUT',
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(response.status, status, await response.clone().text());
  const json = await response.json();
  if (status === 400) {
    assertEquals(json, {
      errcode: 'M_FORBIDDEN',
      error: 'Unencrypted messages in encrypted rooms are disabled',
    });
  }
  return json;
}

suite.test('toggle and content shape apply to HTTP, direct authoring, built ingest and scheduling', async () => {
  const old = config();
  const app = theApp();
  await app.delayedEvents.stop();
  try {
    policy(false, true);
    const user = await suite.registerTestUser('reaction-writers', 'pw');
    const made = await (await suite.matrix(
      new Request('http://x/_matrix/client/v3/createRoom', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token },
        body: '{}',
      }),
    )).json();
    const room = await openRoom(app.store, made.room_id);
    const base = 'rooms/' + encodeURIComponent(room.id);
    const target = await sendLocal(room, {
      type: 'm.room.encrypted',
      sender: user.user_id,
      content: { ciphertext: 'target' },
    }, app.tenant.signer());
    let seq = 0;
    for (const messages of [false, true]) {
      for (const reactions of [false, true]) {
        policy(messages, reactions);
        for (const [label, content, standard] of contentCases(target.eventId)) {
          const allowed = messages || (reactions && standard);
          // Distinct targets avoid duplicate admission without changing legal keys.
          for (const writer of ['http', 'direct', 'built', 'delayed']) {
            const body = structuredClone(content);
            const rel = body['m.relates_to'] as Record<string, unknown> | null;
            if (
              allowed && rel && !Array.isArray(rel) &&
              typeof rel.event_id === 'string'
            ) {
              rel.event_id = (await sendLocal(room, {
                type: 'm.room.encrypted',
                sender: user.user_id,
                content: { ciphertext: 'target' + ++seq },
              }, app.tenant.signer())).eventId;
            }
            const partial = {
              type: 'm.reaction',
              sender: user.user_id,
              content: body,
            };
            if (writer === 'http') {
              const sent = await call(
                user.access_token!,
                base + '/send/m.reaction/t' + ++seq,
                body,
                allowed ? 200 : 400,
              );
              if (allowed) {
                assertEquals(
                  (await call(
                    user.access_token!,
                    base + '/event/' + encodeURIComponent(sent.event_id),
                  )).content,
                  body,
                );
              }
            } else {
              const send = async () => {
                if (writer === 'delayed') {
                  const scheduled = await app.delayedEvents.schedule({
                    roomId: room.id,
                    userId: user.user_id,
                    type: 'm.reaction',
                    stateKey: null,
                    content: body,
                    delay: 60000,
                    deviceId: null,
                  });
                  await app.delayedEvents.action(scheduled.delay_id, 'send');
                  assertEquals(
                    await app.tenant.tx((tx) =>
                      tx.delayedEvents.get(scheduled.delay_id)
                    ),
                    null,
                  );
                  if (standard) {
                    const related = await call(
                      user.access_token!,
                      base + '/relations/' +
                        encodeURIComponent(String(rel!.event_id)) +
                        '/m.annotation/m.reaction',
                      undefined,
                      200,
                      'v1',
                    );
                    assertEquals(
                      related.chunk.map((e: { content: unknown }) => e.content),
                      [body],
                    );
                  }
                } else {
                  const result = writer === 'direct'
                    ? await sendLocal(room, partial, app.tenant.signer())
                    : await ingestLocal(
                      room,
                      await room.tx((tx) =>
                        buildInTx(tx, room.id, partial, app.tenant.signer())
                      ),
                      app.tenant.serverName,
                    );
                  assertEquals(
                    result.standing,
                    'accepted',
                    label + ': ' + writer,
                  );
                  const saved = await room.tx((tx) =>
                    tx.events.get(result.eventId)
                  );
                  assertEquals(JSON.parse(saved!.pdu).content, body);
                }
              };
              if (allowed) await send();
              else {await assertRejects(
                  send,
                  MatrixError,
                  'Unencrypted messages in encrypted rooms are disabled',
                );}
            }
          }
        }
        for (
          const type of [
            'io.element.call.reaction',
            'com.famedly.call.member.reaction',
            'm.poll.response',
            'm.room.message',
          ]
        ) {
          await call(
            user.access_token!,
            base + '/send/' + type + '/other' + ++seq,
            { 'm.relates_to': relation(target.eventId, 'other' + seq) },
            messages ? 200 : 400,
          );
        }
      }
    }
  } finally {
    setConfigForTests(old);
  }
});

suite.test('prepared retries and delayed delivery recheck the toggle; completed receipts replay', async () => {
  const old = config();
  const app = theApp();
  try {
    policy(false, true);
    const user = await suite.registerTestUser('reaction-retry', 'pw');
    const made = await (await suite.matrix(
      new Request('http://x/_matrix/client/v3/createRoom', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + user.access_token },
        body: '{}',
      }),
    )).json();
    const room = await openRoom(app.store, made.room_id);
    const base = 'rooms/' + encodeURIComponent(room.id);
    const target = await sendLocal(room, {
      type: 'm.room.encrypted',
      sender: user.user_id,
      content: { ciphertext: 'target' },
    }, app.tenant.signer());
    const content = { 'm.relates_to': relation(target.eventId) };
    const accepted = await call(
      user.access_token!,
      base + '/send/m.reaction/accepted',
      content,
    );
    const device = await deviceIdentity(
      app.tenant,
      'reaction-retry',
      user.device_id!,
    );
    const submission = transactionSubmission(app.tenant, device, {
      kind: 'send',
      roomId: room.id,
      eventType: 'm.reaction',
    }, 'prepared')!;
    const preparedContent = {
      'm.relates_to': relation(target.eventId, 'prepared'),
    };
    const pdu = await room.tx((tx) =>
      buildInTx(tx, room.id, {
        type: 'm.reaction',
        sender: user.user_id,
        content: preparedContent,
      }, app.tenant.signer())
    );
    await submission.prepare(pdu);
    const pending = await app.delayedEvents.schedule({
      roomId: room.id,
      userId: user.user_id,
      type: 'm.reaction',
      stateKey: null,
      content: { 'm.relates_to': relation(target.eventId, 'delayed') },
      delay: 60000,
      deviceId: null,
    });
    policy(false, false);
    await call(user.access_token!, base + '/send/m.reaction/prepared', {}, 400);
    assertEquals(
      await room.tx((tx) => tx.events.get(String(pdu.event_id))),
      null,
    );
    assertEquals((await submission.lookup())!.pdu, pdu);
    await assertRejects(
      () => app.delayedEvents.action(pending.delay_id, 'send'),
      MatrixError,
      'Unencrypted messages in encrypted rooms are disabled',
    );
    assertEquals(
      await call(user.access_token!, base + '/send/m.reaction/accepted', {}),
      accepted,
    );
    policy(false, true);
    const retried = await call(
      user.access_token!,
      base + '/send/m.reaction/prepared',
      { body: 'retry body is not the prepared event' },
    );
    assertEquals(retried.event_id, pdu.event_id);
    assertEquals(
      (await call(
        user.access_token!,
        base + '/event/' + encodeURIComponent(retried.event_id),
      )).content,
      preparedContent,
    );
  } finally {
    setConfigForTests(old);
  }
});
