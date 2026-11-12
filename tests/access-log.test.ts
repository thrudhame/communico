import { assert, assertEquals } from '@std/assert';
import type { Context, PathfinderRequest } from '@pathfinder/pathfinder';
import logRequest from '#engine/access-log.ts';

// Failing-first at the logging boundary, not by matching an import failure.
// The real router already omits queries; this boundary also refuses a target
// carrying query text from another adapter. Never add queries to real logs.
const secret = 'privateCredentialForLogTest';
const forms: [string, string, string][] = [
  [
    'client access_token',
    '/_matrix/client/v3/sync?access_token=' + secret,
    '/_matrix/client/v3/sync',
  ],
  [
    'OpenID access_token',
    '/_matrix/federation/v1/openid/userinfo?access_token=' + secret,
    '/_matrix/federation/v1/openid/userinfo',
  ],
  [
    'token',
    '/_matrix/client/v3/login?token=' + secret,
    '/_matrix/client/v3/login',
  ],
  [
    'login_token',
    '/_matrix/client/v3/login?login_token=' + secret,
    '/_matrix/client/v3/login',
  ],
  [
    'loginToken',
    '/_matrix/client/v3/login?loginToken=' + secret,
    '/_matrix/client/v3/login',
  ],
  [
    'registration token',
    '/_matrix/client/v1/register/m.login.registration_token/validity?token=' +
    secret,
    '/_matrix/client/v1/register/m.login.registration_token/validity',
  ],
  [
    'registration_token query',
    '/_matrix/client/v3/register?registration_token=' + secret,
    '/_matrix/client/v3/register',
  ],
  [
    'password query',
    '/_matrix/client/v3/login?password=' + secret,
    '/_matrix/client/v3/login',
  ],
  ['future unknown query', '/unknown?future_auth=' + secret, '/unknown'],
  [
    'encoded repeated query',
    '/unknown?%61ccess_token=' + secret + '&access_token=' + secret,
    '/unknown',
  ],
  [
    'delayed body action',
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/' + secret,
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/[REDACTED]',
  ],
  [
    'delayed path action',
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/' + secret +
    '/restart',
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/[REDACTED]/restart',
  ],
  [
    'delayed miss',
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/' + secret +
    '/unknown/' + secret,
    '/_matrix/client/unstable/org.matrix.msc4140/delayed_events/[REDACTED]',
  ],
  [
    'encoded delayed anchor',
    '/_matrix/client/unstable/org.matrix.msc4140/%64elayed_events/' +
    encodeURIComponent(secret + '/part'),
    '/_matrix/client/unstable/org.matrix.msc4140/%64elayed_events/[REDACTED]',
  ],
  [
    'third-party invitation token',
    '/_matrix/client/v3/rooms/!room:test/state/m.room.third_party_invite/' +
    secret,
    '/_matrix/client/v3/rooms/!room:test/state/m.room.third_party_invite/[REDACTED]',
  ],
  [
    'encoded invitation state type',
    '/_matrix/client/v3/rooms/!room:test/state/m.room.%74hird_party_invite/' +
    encodeURIComponent(secret + '/part'),
    '/_matrix/client/v3/rooms/!room:test/state/m.room.%74hird_party_invite/[REDACTED]',
  ],
  [
    'explicit token path on miss',
    '/unknown/token/' + secret,
    '/unknown/token/[REDACTED]',
  ],
  [
    'explicit login-token path on miss',
    '/unknown/login-token/' + secret,
    '/unknown/login-token/[REDACTED]',
  ],
  [
    'explicit registration-token path on miss',
    '/unknown/registration_token/' + secret,
    '/unknown/registration_token/[REDACTED]',
  ],
  [
    'explicit password path on miss',
    '/unknown/password/' + secret,
    '/unknown/password/[REDACTED]',
  ],
  [
    'malformed escape fails closed',
    '/unknown/%zz/' + secret,
    '[REDACTED-PATH]',
  ],
];

async function capture(
  path: string,
  completed: Promise<void> = Promise.resolve(),
) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    const request = { path, method: 'POST', completed } as PathfinderRequest;
    const context = {} as Context;
    const post = await logRequest(request, context);
    assert(typeof post === 'function');
    await post({ status: 404 } as Parameters<typeof post>[0]);
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    assertEquals(
      request.path,
      path,
      'the actual request must remain unchanged',
    );
    return lines;
  } finally {
    console.log = original;
  }
}
for (const [name, target, safe] of forms) {
  Deno.test(
    'access log redacts ' + name + ' at head and completion',
    async () => {
      const lines = await capture(target);
      assertEquals(lines.length, 2, 'retain the existing log count');
      assert(lines.every((line) => !line.includes(secret)), name + ' leaked');
      assert(lines[0].startsWith('[pathfinder] POST ' + safe + ' 404 +'));
      assert(lines[1].startsWith('[pathfinder] POST ' + safe + ' sent '));
    },
  );
}
Deno.test('access log retains public path diagnostics and aborted disposition', async () => {
  const path =
    '/_matrix/client/v3/rooms/%21public%3Atest/state/m.room.topic/public-key';
  const failure = Promise.reject(new Error('transport aborted'));
  failure.catch(() => {});
  const lines = await capture(path, failure);
  assertEquals(lines.length, 2);
  assert(lines[0].includes(path + ' 404 +'));
  assert(lines[1].includes(path + ' aborted '));
});
