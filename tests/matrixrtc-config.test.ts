import { assertEquals, assertThrows } from '@std/assert';
import { ConfigError, loadConfig } from '#engine/config.ts';

Deno.test('RTC URL is layered, explicitly disabled, and validated before discovery', async () => {
  const dir = await Deno.makeTempDir();
  try {
    const overlay = dir + '/overlay.toml';
    await Deno.writeTextFile(
      overlay,
      '[matrixrtc]\nlivekitserviceurl="https://rtc.example/jwt"\n',
    );
    const opts = {
      defaultsPath: 'defaults/communico.toml',
      configPath: overlay,
      env: {},
    };
    assertEquals(
      loadConfig(opts).config.matrixrtc.livekitserviceurl,
      'https://rtc.example/jwt',
    );
    assertEquals(
      loadConfig({
        ...opts,
        env: { COMMUNICO_MATRIXRTC_LIVEKITSERVICEURL: '' },
      }).config.matrixrtc.livekitserviceurl,
      '',
    );
    assertEquals(
      loadConfig({ ...opts, configPath: null }).config.matrixrtc
        .livekitserviceurl,
      '',
    );
    for (
      const value of [
        'relative',
        'wss://rtc.example',
        'https://user:secret@rtc.example',
        'https://rtc.example/#fragment',
      ]
    ) {
      assertThrows(
        () =>
          loadConfig({
            ...opts,
            env: { COMMUNICO_MATRIXRTC_LIVEKITSERVICEURL: value },
          }),
        ConfigError,
        'matrixrtc.livekitserviceurl',
      );
    }
    assertEquals(
      loadConfig({
        ...opts,
        env: { COMMUNICO_MATRIXRTC_LIVEKITSERVICEURL: 'http://127.0.0.1:8080' },
      }).config.matrixrtc.livekitserviceurl,
      'http://127.0.0.1:8080',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
