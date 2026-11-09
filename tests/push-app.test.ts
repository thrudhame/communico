import { assertEquals, assertRejects } from '@std/assert';
import { closeApp, openApp } from '#engine/app.ts';
import { setConfigForTests } from '#engine/config.ts';

Deno.test('push app: startup failure drains already-started services before closing storage', async () => {
  const dir = await Deno.makeTempDir();
  const options = {
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  };
  try {
    setConfigForTests({ push: { cacerts: [dir + '/missing-root.pem'] } });
    await assertRejects(() => openApp(options), Deno.errors.NotFound);
    setConfigForTests({ federation: { enabled: false } });
    const app = await openApp(options);
    assertEquals(app.sender, null);
    await app.pushSender.tick();
    await closeApp();
  } finally {
    setConfigForTests({});
    await closeApp();
    await Deno.remove(dir, { recursive: true });
  }
});
