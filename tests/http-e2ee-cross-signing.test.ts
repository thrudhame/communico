import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP cross-signing keys');
async function key(user: string, usage: string) {
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  return {
    pair,
    pub,
    id: 'ed25519:' + pub,
    json: {
      user_id: user,
      usage: [usage],
      keys: { ['ed25519:' + pub]: pub },
    } as Json,
  };
}
async function call(
  token: string,
  path: string,
  body?: unknown,
  status = 200,
): Promise<Json> {
  const response = await suite.matrix(
    new Request('http://x/_matrix/client/v3/' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: 'Bearer ' + token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  assertEquals(response.status, status, await response.clone().text());
  return await response.json();
}
async function keys(token: string, user: string): Promise<Json> {
  return await call(token, 'keys/query', { device_keys: { [user]: [] } });
}

suite.test('first set, exact retry, UIA replacement and private key visibility', async () => {
  const a = await suite.registerTestUser('sign-a', 'pw');
  const b = await suite.registerTestUser('sign-b', 'pw');
  const master = await key(a.user_id, 'master');
  const self = await key(a.user_id, 'self_signing');
  const privateKey = await key(a.user_id, 'user_signing');
  await signJson(self.json, a.user_id, master.id, master.pair.privateKey);
  await signJson(privateKey.json, a.user_id, master.id, master.pair.privateKey);
  // Third-party signatures must never become public graph data.
  master.json.signatures = {
    '@hidden:elsewhere': { 'ed25519:private': 'opaque' },
  };
  const body = {
    master_key: master.json,
    self_signing_key: self.json,
    user_signing_key: privateKey.json,
  };
  const before = await call(a.access_token!, 'sync?timeout=0');
  await call(a.access_token!, 'keys/device_signing/upload', body);
  await call(a.access_token!, 'keys/device_signing/upload', body);
  const own = await keys(a.access_token!, a.user_id);
  assertEquals((own.user_signing_keys as Json)[a.user_id], privateKey.json);
  const publicView = await keys(b.access_token!, a.user_id);
  assertEquals(publicView.user_signing_keys, {});
  assertEquals(
    ((publicView.master_keys as Json)[a.user_id] as Json).signatures,
    {},
  );
  assertEquals((publicView.self_signing_keys as Json)[a.user_id], self.json);
  const after = await call(
    a.access_token!,
    'sync?timeout=0&since=' + before.next_batch,
  );
  assert(
    (after.device_lists as { changed: string[] }).changed.includes(a.user_id),
  );

  const replacement = await key(a.user_id, 'master');
  const challenge = await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: replacement.json,
  }, 401);
  assertEquals(challenge.flows, [{ stages: ['m.login.password'] }]);
  await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: replacement.json,
    auth: {
      type: 'm.login.password',
      session: challenge.session,
      password: 'pw',
      identifier: { type: 'm.id.user', user: b.user_id },
    },
  }, 403);
  await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: replacement.json,
    auth: {
      type: 'm.login.password',
      session: challenge.session,
      password: 'bad',
    },
  }, 401);
  await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: replacement.json,
    auth: {
      type: 'm.login.password',
      session: challenge.session,
      password: 'pw',
    },
  });
  const rotated = await keys(a.access_token!, a.user_id);
  assertEquals(
    ((rotated.master_keys as Json)[a.user_id] as Json).keys,
    replacement.json.keys,
  );
  assertEquals(rotated.self_signing_keys, {});
  assertEquals(rotated.user_signing_keys, {});
  // Adding a new subordinate to an existing master is not an exact retry.
  const nextSelf = await key(a.user_id, 'self_signing');
  await signJson(
    nextSelf.json,
    a.user_id,
    replacement.id,
    replacement.pair.privateKey,
  );
  await call(a.access_token!, 'keys/device_signing/upload', {
    self_signing_key: nextSelf.json,
  }, 401);
});

suite.test('structure, crypto and collisions reject atomically in both directions', async () => {
  const a = await suite.registerTestUser('sign-invalid', 'pw');
  const master = await key(a.user_id, 'master');
  const self = await key(a.user_id, 'self_signing');
  await signJson(self.json, a.user_id, master.id, self.pair.privateKey);
  await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: master.json,
    self_signing_key: self.json,
  }, 400);
  assertEquals((await keys(a.access_token!, a.user_id)).master_keys, {});
  for (
    const bad of [
      { ...master.json, user_id: '@wrong:elsewhere' },
      { ...master.json, usage: ['self_signing'] },
      {
        ...master.json,
        keys: { ...master.json.keys as Json, 'ed25519:extra': 'extra' },
      },
      { ...master.json, keys: { 'ed25519:wrong': master.pub } },
    ]
  ) {
    await call(a.access_token!, 'keys/device_signing/upload', {
      master_key: bad,
    }, 400);
  }
  await call(a.access_token!, 'login', {
    type: 'm.login.password',
    user: 'sign-invalid',
    password: 'pw',
    device_id: master.pub,
  });
  await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: master.json,
  }, 403);
  const second = await key(a.user_id, 'master');
  await call(a.access_token!, 'keys/device_signing/upload', {
    master_key: second.json,
  });
  await call(a.access_token!, 'login', {
    type: 'm.login.password',
    user: 'sign-invalid',
    password: 'pw',
    device_id: second.pub,
  }, 403);
});
