import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { latch, watchdog } from '#tests/support/ordering.ts';

const suite = httpSuite('HTTP access log credential boundary');
suite.test('real successes, errors and misses redact path credentials without query logging', async () => {
  const secret = 'privateHttpCredentialForLogTest';
  const paths = [
    '/_matrix/client/v3/sync%3Faccess_token=' + secret,
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events//' + secret,
    '/_matrix/client/v3/sync?access_token=' + secret,
    '/_matrix/federation/v1/openid/userinfo?access_token=' + secret,
    '/_matrix/client/v3/login?token=' + secret + '&login_token=' + secret,
    '/_matrix/client/v1/register/m.login.registration_token/validity?token=' +
    secret,
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/' + secret +
    '/restart',
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/' + secret +
    '/miss/' + secret,
    '/_matrix/client/v3/rooms/!room:test/state/m.room.third_party_invite/' +
    secret,
    '/_matrix/client/v3/rooms/!room:test/state/m.room.%74hird_party_invite/' +
    secret,
    '/unknown/login-token/' + secret,
  ];
  const lines: string[] = [];
  const original = console.log;
  let completion = latch();
  console.log = (...args: unknown[]) => {
    const line = args.join(' ');
    lines.push(line);
    if (/^\[pathfinder\] GET .* sent [\d.]+ms$/.test(line)) {
      completion.release();
    }
  };
  try {
    for (const path of paths) {
      completion = latch();
      const before = lines.filter((line) =>
        /^\[pathfinder\] GET /.test(line)
      ).length;
      const response = await suite.matrix(new Request('http://x' + path));
      assert([200, 401, 404, 405].includes(response.status));
      await response.text();
      await watchdog(
        completion.wait,
        'real HTTP access-log completion callback',
      );
      assertEquals(
        lines.filter((line) => /^\[pathfinder\] GET /.test(line)).length -
          before,
        2,
        'each request owns exactly its head and completion log lines',
      );
    }
  } finally {
    console.log = original;
  }
  const requests = lines.filter((line) => /^\[pathfinder\] GET /.test(line));
  assert(requests.some((line) => line.includes('GET [REDACTED-PATH] ')));
  assertEquals(requests.length, paths.length * 2, 'no extra access-log lines');
  assert(
    requests.every((line) => !line.includes(secret)),
    'head/completion leaked a URL credential',
  );
  assert(
    requests.every((line) => !line.includes('?')),
    'query strings must remain omitted',
  );
  assert(
    requests.some((line) =>
      line.includes('/delayed_events/[REDACTED]/restart ')
    ),
  );
  assert(
    requests.some((line) =>
      line.includes('/m.room.third_party_invite/[REDACTED] ')
    ),
  );
});
