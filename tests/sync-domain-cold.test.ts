import { assertEquals } from '@std/assert';
import {
  encodeStreamToken,
  formatPosition,
  parsePosition,
  parseStreamToken,
} from '#engine/client/tokens.ts';
import { bounded, serverProcess } from './helpers/server-process.ts';

Deno.test('cold ordinary sync retains its domain and session, acknowledges only the old issued prefix and delivers the unseen inbox tail', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'sync-domain-cold-' });
  let server = await serverProcess({ dir });
  try {
    const input = {
      username: 'domain-cold',
      password: 'pw',
    };
    const challenge = await server.api('v3/register', input);
    assertEquals(challenge.status, 401);
    const registered = await server.api('v3/register', {
      ...input,
      auth: { type: 'm.login.dummy', session: challenge.body.session },
    });
    assertEquals(registered.status, 200);
    const user = registered.body;
    const room = await server.api('v3/createRoom', {}, user.access_token);
    assertEquals(room.status, 200);
    const roomPath = 'v3/rooms/' + encodeURIComponent(room.body.room_id);
    const page = await server.api(
      roomPath + '/messages?dir=b&limit=1',
      undefined,
      user.access_token,
    );
    assertEquals(page.status, 200);
    const bookmark = parsePosition(page.body.end)!;
    assertEquals(typeof bookmark.domain, 'string');
    const pagePath = roomPath + '/messages?dir=b&limit=1&from=';
    const tail = await server.api(
      pagePath + page.body.end,
      undefined,
      user.access_token,
    );
    assertEquals(tail.status, 200);
    const send = async (marker: string) => {
      const response = await fetch(
        'http://127.0.0.1:' + server.port +
          '/_matrix/client/v3/sendToDevice/m.room_key/' + marker,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer ' + user.access_token },
          body: JSON.stringify({
            messages: { [user.user_id]: { [user.device_id]: { marker } } },
          }),
        },
      );
      assertEquals(response.status, 200, await response.clone().text());
      await response.body?.cancel();
    };
    await send('issued');
    const first = await server.api('v3/sync', undefined, user.access_token);
    assertEquals(first.status, 200);
    assertEquals(
      first.body.to_device.events.map((event: {
        content: { marker: string };
      }) => event.content.marker),
      ['issued'],
    );
    await send('unseen');
    const position = parseStreamToken(first.body.next_batch)!;
    assertEquals(typeof position.domain, 'string');
    server.child.kill('SIGTERM');
    assertEquals((await bounded(server.output)).code, 0);
    await server.dispose();
    server = await serverProcess({ dir });
    const reopenedPage = await server.api(
      pagePath + page.body.end,
      undefined,
      user.access_token,
    );
    assertEquals(reopenedPage.status, 200);
    assertEquals(
      reopenedPage.body.chunk.map((event: { event_id: string }) =>
        event.event_id
      ),
      tail.body.chunk.map((event: { event_id: string }) => event.event_id),
    );
    assertEquals(reopenedPage.body.end, tail.body.end);
    const foreignPage = await server.api(
      pagePath + formatPosition(crypto.randomUUID(), bookmark.payload),
      undefined,
      user.access_token,
    );
    assertEquals([foreignPage.status, foreignPage.body.errcode], [
      400,
      'M_INVALID_PARAM',
    ]);
    const resumed = await server.api(
      'v3/sync?since=' + first.body.next_batch,
      undefined,
      user.access_token,
    );
    assertEquals(resumed.status, 200);
    assertEquals(
      parseStreamToken(resumed.body.next_batch)?.domain,
      position.domain,
    );
    assertEquals(
      resumed.body.to_device.events.map((event: {
        content: { marker: string };
      }) => event.content.marker),
      ['unseen'],
    );
    const foreign = await server.api(
      'v3/sync?since=' + encodeStreamToken({
        ...parseStreamToken(resumed.body.next_batch)!,
        domain: crypto.randomUUID(),
      }),
      undefined,
      user.access_token,
    );
    assertEquals(foreign.status, 400);
    assertEquals(foreign.body.errcode, 'M_UNKNOWN_POS');
    const repeat = await server.api(
      'v3/sync?since=' + first.body.next_batch,
      undefined,
      user.access_token,
    );
    assertEquals(repeat.status, 200);
    assertEquals(repeat.body.to_device, resumed.body.to_device);
    const acknowledged = await server.api(
      'v3/sync?since=' + resumed.body.next_batch,
      undefined,
      user.access_token,
    );
    assertEquals(acknowledged.status, 200);
    assertEquals(acknowledged.body.to_device, { events: [] });
    server.child.kill('SIGTERM');
    assertEquals((await bounded(server.output)).code, 0);
  } finally {
    await server.dispose();
    await Deno.remove(dir, { recursive: true });
  }
});
