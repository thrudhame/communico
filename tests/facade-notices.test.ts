import { assertEquals, assertRejects } from '@std/assert';
import { LinkError } from '#engine/facade/protocol.ts';
import {
  lines,
  noticeHeads,
  NoticeHub,
  sseMessages,
} from '#engine/facade/notices.ts';
import { LinkClient, startLinkTransport } from '#engine/facade/transport.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('notice framing survives split UTF-8, CRLF and multiline SSE', async () => {
  const input = new TextEncoder().encode(
    ': ignored\r\ndata: {"text":\r\ndata: "\u00e9"}\r\n\r\ndata: incomplete',
  );
  const chunks = () =>
    ReadableStream.from([...input].map((byte) => new Uint8Array([byte])));
  assertEquals(await Array.fromAsync(sseMessages(chunks())), [
    '{"text":\n"\u00e9"}',
  ]);
  assertEquals(await Array.fromAsync(lines(chunks())), [
    ': ignored',
    'data: {"text":',
    'data: "\u00e9"}',
    '',
  ]);
  assertEquals(
    noticeHeads([{
      source: 'edge',
      incarnation: 'one',
      stream: 'control',
      head: { sequence: 0, hash: '' },
      payload: 'discarded',
    }]),
    [{
      source: 'edge',
      incarnation: 'one',
      stream: 'control',
      head: { sequence: 0, hash: '' },
    }],
  );
});

Deno.test('notice wakeups coalesce while a durable snapshot is being read', async () => {
  const hub = new NoticeHub();
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let reads = 0;
  const response = hub.response(
    async () => {
      reads++;
      if (reads === 1) {
        entered.resolve();
        await release.promise;
      }
      return { heads: [], reads };
    },
    abort.signal,
    true,
  );
  const reader = response.body!.getReader();
  try {
    const first = reader.read();
    await entered.promise;
    for (let i = 0; i < 100; i++) hub.changed();
    release.resolve();
    assertEquals(
      new TextDecoder().decode((await first).value),
      '{"heads":[],"reads":1}\n',
    );
    assertEquals(
      new TextDecoder().decode((await reader.read()).value),
      '{"heads":[],"reads":2}\n',
    );
    abort.abort();
    assertEquals((await reader.read()).done, true);
    hub.changed();
    assertEquals(reads, 2);
  } finally {
    abort.abort();
    release.resolve();
    await reader.cancel();
    reader.releaseLock();
  }
});

Deno.test('WebSocket uses the HTTP TLS pin boundary and aborts idle notices at shutdown', async () => {
  const f = await facadeTls();
  const hub = new NoticeHub();
  let admitted = 0;
  const server = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: f.facade,
    authorize: (pin) => Promise.resolve(pin === f.homePin),
    handle: (req) => {
      admitted++;
      return Promise.resolve(
        hub.response(() => Promise.resolve({ heads: [] }), req.signal, true),
      );
    },
  });
  const abort = new AbortController();
  try {
    const wrongPin = new LinkClient(f.home, {
      url: server.url,
      pin: f.wrongPin,
    });
    await assertRejects(() =>
      wrongPin.websocket('/_communico/link/v1/notices', {
        headers: {},
        signal: abort.signal,
      })
    );
    assertEquals(admitted, 0);
    for (
      const tls of [{ ...f.home, ca: [f.wrong.cert] }, {
        ...f.home,
        cert: '',
        key: '',
      }]
    ) {
      const wrongTls = new LinkClient(tls, {
        url: server.url,
        pin: f.facadePin,
      });
      await assertRejects(() =>
        wrongTls.websocket('/_communico/link/v1/notices', {
          headers: {},
          signal: abort.signal,
        })
      );
      assertEquals(admitted, 0);
    }
    const wrongHome = new LinkClient(f.wrong, {
      url: server.url,
      pin: f.facadePin,
    });
    await assertRejects(() =>
      wrongHome.websocket('/_communico/link/v1/notices', {
        headers: {},
        signal: abort.signal,
      })
    );
    assertEquals(admitted, 0);
    const client = new LinkClient(f.home, {
      url: server.url,
      pin: f.facadePin,
    });
    await assertRejects(
      () =>
        client.websocket('/_matrix/key/v2/server', {
          headers: {},
          signal: abort.signal,
        }),
      LinkError,
    );
    const body = await client.websocket('/_communico/link/v1/notices', {
      headers: {},
      signal: abort.signal,
    });
    const reader = body.getReader();
    assertEquals(JSON.parse((await reader.read()).value!), { heads: [] });
    assertEquals(admitted, 1);
    await server.close();
    assertEquals((await reader.read()).done, true);
    reader.releaseLock();
  } finally {
    abort.abort();
    await server.close();
    await f.close();
  }
});
