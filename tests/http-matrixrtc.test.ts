import { assertEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP MatrixRTC shared discovery');
const registry = '/_matrix/client/unstable/org.matrix.msc4143/rtc/transports';
async function call(path: string, token?: string) {
  const response = await suite.matrix(
    new Request('http://x' + path, {
      headers: token ? { Authorization: 'Bearer ' + token } : {},
    }),
  );
  return { status: response.status, body: await response.json() };
}
suite.test('unconfigured backend is absent and registry authenticates', async () => {
  const user = await suite.registerTestUser('rtc-off', 'pw');
  assertEquals((await call(registry)).status, 401);
  assertEquals((await call(registry, 'invalid')).status, 401);
  const result = await call(registry, user.access_token!);
  assertEquals(result.status, 200);
  assertEquals(result.body, {});
  assertEquals(
    (await call('/_matrix/client/versions')).body
      .unstable_features['org.matrix.msc4143'],
    false,
  );
});
suite.test('one backend source feeds authenticated registry and legacy public discovery', async () => {
  const user = await suite.registerTestUser('rtc-on', 'pw');
  try {
    setConfigForTests({
      matrixrtc: { livekitserviceurl: 'https://rtc.example/jwt' },
      wellknown: { client: 'https://matrix.example/' },
      federation: { enabled: false },
    });
    const transport = {
      type: 'livekit',
      livekit_service_url: 'https://rtc.example/jwt',
    };
    assertEquals((await call(registry)).status, 401);
    assertEquals((await call(registry, user.access_token!)).body, {
      rtc_transports: [transport],
    });
    assertEquals((await call('/.well-known/matrix/client')).body, {
      'm.homeserver': { base_url: 'https://matrix.example/' },
      'org.matrix.msc4143.rtc_foci': [transport],
    });
    assertEquals(
      (await call('/_matrix/client/versions')).body
        .unstable_features['org.matrix.msc4143'],
      true,
    );
    setConfigForTests({ wellknown: { client: 'https://matrix.example/' } });
    assertEquals((await call('/.well-known/matrix/client')).body, {
      'm.homeserver': { base_url: 'https://matrix.example/' },
    });
  } finally {
    setConfigForTests({});
  }
});
