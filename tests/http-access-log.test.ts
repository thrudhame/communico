import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';

const suite = httpSuite('HTTP access log credential boundary');
suite.test('real successes, errors and misses redact path credentials without query logging', async () => {
  const secret = 'privateHttpCredentialForLogTest';
  const paths = [
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
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    for (const path of paths) {
      const response = await suite.matrix(new Request('http://x' + path));
      assert([200, 401, 404].includes(response.status));
      await response.text();
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  } finally {
    console.log = original;
  }
  const requests = lines.filter((line) => /^\[pathfinder\] GET /.test(line));
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
