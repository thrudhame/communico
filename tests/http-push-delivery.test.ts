import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { setConfigForTests } from '#engine/config.ts';
import { startPushSender } from '#engine/push/sender.ts';

type Json = Record<string, unknown>;
Deno.test('HTTP push delivery: real HTTPS consumer sees rich encrypted/plaintext, explicit minimal, retry, read-zero, rejected and logout lifecycle', async () => {
  const requests: Json[] = [];
  let verdict = 'ok';
  const peer = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile('tests/fixtures/tls/localhost.crt'),
    key: await Deno.readTextFile('tests/fixtures/tls/localhost.key'),
    onListen() {},
  }, async (req) => {
    assertEquals(new URL(req.url).pathname, '/_matrix/push/v1/notify');
    assertEquals(req.headers.get('authorization'), null);
    requests.push((await req.json()).notification as Json);
    return verdict === 'invalid'
      ? Response.json({ wrong: [] })
      : Response.json({ rejected: verdict === 'reject' ? ['key'] : [] });
  });
  setConfigForTests({
    push: {
      cacerts: ['tests/fixtures/tls/ca.crt'],
      allowlist: ['127.0.0.1/32'],
      readretentiondays: 0,
    },
    encryption: { allowunencryptedcreation: true },
  });
  const http = await startHttp();
  // Control scheduling, not transport. The app starts this same worker;
  // publish/read/revoke below happen before the explicitly selected pass.
  await http.app.pushSender.stop();
  const delivery = await startPushSender({
    store: http.app.store,
    tenant: http.app.tenant,
    automatic: false,
  });
  const url = `https://127.0.0.1:${peer.addr.port}/_matrix/push/v1/notify`;
  async function call(
    path: string,
    token: string,
    body?: unknown,
    method?: string,
  ) {
    const response = await http.matrix(
      new Request('http://x/_matrix/client/v3/' + path, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { Authorization: 'Bearer ' + token },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json() as Json;
  }
  try {
    const a = await http.registerTestUser('gateway-a', 'pw');
    const b = await http.registerTestUser('gateway-b', 'pw');
    const room = String(
      (await call('createRoom', a.access_token!, {
        name: 'Encrypted room',
        invite: [b.user_id],
        initial_state: [{
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        }],
      })).room_id,
    );
    const plain = String(
      (await call('createRoom', a.access_token!, {
        name: 'Plain room',
        invite: [b.user_id],
      })).room_id,
    );
    for (const r of [room, plain]) {
      await call(
        'rooms/' + encodeURIComponent(r) + '/join',
        b.access_token!,
        {},
      );
    }
    const register = (minimal = false) =>
      call('pushers/set', b.access_token!, {
        app_id: 'app',
        pushkey: 'key',
        kind: 'http',
        app_display_name: 'App',
        device_display_name: 'B',
        lang: 'en',
        data: {
          url,
          custom: { kept: 7 },
          ...(minimal ? { format: 'event_id_only' } : {}),
        },
      });
    await register();
    await delivery.tick();
    assertEquals(requests, []);
    const send = async (r: string, type: string, body: Json, txn: string) =>
      String(
        (await call(
          'rooms/' + encodeURIComponent(r) + '/send/' + type + '/' + txn,
          a.access_token!,
          body,
          'PUT',
        )).event_id,
      );
    const ciphertext = {
      algorithm: 'm.megolm.v1.aes-sha2',
      ciphertext: 'opaque-not-plaintext',
      session_id: 'session',
      sender_key: 'key',
      device_id: 'A',
    };
    const encrypted = await send(
      room,
      'm.room.encrypted',
      ciphertext,
      'encrypted',
    );
    await delivery.tick();
    let notification = requests.find((n) => n.event_id === encrypted)!;
    assert(notification);
    assertEquals(notification.content, ciphertext);
    assertEquals(notification.type, 'm.room.encrypted');
    assertEquals(notification.room_name, 'Encrypted room');
    assertEquals((notification.devices as Json[])[0].data, {
      custom: { kept: 7 },
    });
    const plaintext = await send(plain, 'm.room.message', {
      body: 'visible plaintext',
      msgtype: 'm.text',
      'm.mentions': {},
    }, 'plaintext');
    await delivery.tick();
    notification = requests.find((n) => n.event_id === plaintext)!;
    assertEquals((notification.content as Json).body, 'visible plaintext');
    assertEquals(notification.counts, { unread: 2 });
    await register(true);
    const minimal = await send(room, 'm.room.encrypted', ciphertext, 'minimal');
    await delivery.tick();
    notification = requests.find((n) => n.event_id === minimal)!;
    assertEquals(Object.keys(notification).sort(), [
      'counts',
      'devices',
      'event_id',
      'prio',
      'room_id',
    ]);
    assertEquals((notification.devices as Json[])[0].tweaks, undefined);
    for (const [r, event] of [[room, minimal], [plain, plaintext]]) {
      await call(
        'rooms/' + encodeURIComponent(r) + '/receipt/m.read.private/' +
          encodeURIComponent(event),
        b.access_token!,
        {},
      );
    }
    await delivery.tick();
    assertEquals(requests.at(-1)!.counts, { unread: 0 });
    assertEquals(requests.at(-1)!.event_id, undefined);
    verdict = 'invalid';
    const retry = await send(plain, 'm.room.message', {
      body: 'retry invalid verdict',
    }, 'retry');
    await delivery.tick();
    assertEquals(
      (await call('pushers', b.access_token!)).pushers instanceof Array,
      true,
    );
    const row = (await http.app.server.query(
      'SELECT state,attempts FROM push_delivery WHERE event=?',
      [retry],
    ))[0];
    assertEquals(row, { state: 'pending', attempts: 1 });
    verdict = 'ok';
    await http.app.server.execute(
      'UPDATE push_delivery SET next_ms=0 WHERE event=?',
      [retry],
    );
    await delivery.tick();
    assertEquals(
      (await http.app.server.query(
        'SELECT state FROM push_delivery WHERE event=?',
        [retry],
      ))[0].state,
      'sent',
    );
    verdict = 'reject';
    await send(plain, 'm.room.message', { body: 'reject key' }, 'reject');
    await delivery.tick();
    assertEquals((await call('pushers', b.access_token!)).pushers, []);
    verdict = 'ok';
    await register();
    const logoutEvent = await send(plain, 'm.room.message', {
      body: 'logout before send',
    }, 'logout');
    await call('logout', b.access_token!, {});
    await delivery.tick();
    assertEquals(requests.filter((n) => n.event_id === logoutEvent), []);
    for (const n of requests) {
      assertEquals(n.access_token, undefined);
      assertEquals(n.unsigned, undefined);
      assertEquals((n.devices as Json[])[0].access_token, undefined);
      assertEquals(((n.devices as Json[])[0].data as Json).url, undefined);
    }
  } finally {
    await delivery.stop();
    await http.close();
    await peer.shutdown();
    setConfigForTests({});
  }
});
