import { assertEquals } from '@std/assert';
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { encodeStreamToken, parseStreamToken } from '#engine/client/tokens.ts';
import { insertMessage } from '#engine/tenant/todevice.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP legacy stream receipt recovery');
suite.test('legacy read positions never reconstruct pre-domain deletion authority', async () => {
  const user = await suite.registerTestUser('legacy-receipt', 'pw');
  const app = theApp();
  const db = await app.store.tenant(app.tenant.serverName);
  const device = await deviceIdentity(
    app.tenant,
    'legacy-receipt',
    user.device_id!,
  );
  await db.tx((conn) =>
    insertMessage(conn, device, 'legacy-pending', {
      type: 'm.room_key',
      content: { retained: true },
    }, config().e2ee)
  );
  // A real receipt from the prior wire era, not a fabricated high inbox number.
  const old = await app.tenant.tx((tx) =>
    tx.toDevice.deliver(device, parseStreamToken('s0')!, config().e2ee)
  );
  const sync = async (since: string) => {
    const response = await suite.matrix(
      new Request(
        'http://x/_matrix/client/v3/sync?since=' + since,
        { headers: { Authorization: 'Bearer ' + user.access_token } },
      ),
    );
    assertEquals(response.status, 200, await response.clone().text());
    return await response.json();
  };
  const recovered = await sync(encodeStreamToken(old.token));
  assertEquals(recovered.to_device.events, old.events);
  assertEquals(typeof parseStreamToken(recovered.next_batch)?.domain, 'string');
  assertEquals((await sync(recovered.next_batch)).to_device.events, []);
});
