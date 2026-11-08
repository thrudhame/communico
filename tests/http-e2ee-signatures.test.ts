import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/ids.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

type Json = Record<string, unknown>;
const suite = httpSuite('HTTP verified key signatures');
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
async function setup(name: string) {
  const user = await suite.registerTestUser(name, 'pw');
  const master = await key(user.user_id, 'master'),
    self = await key(user.user_id, 'self_signing'),
    secret = await key(user.user_id, 'user_signing');
  await signJson(self.json, user.user_id, master.id, master.pair.privateKey);
  await signJson(secret.json, user.user_id, master.id, master.pair.privateKey);
  await call(user.access_token!, 'keys/device_signing/upload', {
    master_key: master.json,
    self_signing_key: self.json,
    user_signing_key: secret.json,
  });
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const device = {
    user_id: user.user_id,
    device_id: user.device_id,
    algorithms: ['m.olm.v1.curve25519-aes-sha2'],
    keys: {
      ['ed25519:' + user.device_id]: b64encodeStd(
        await exportPublicKeyRaw(pair.publicKey),
      ),
    },
    signatures: {},
  } as Json;
  await signJson(
    device,
    user.user_id,
    'ed25519:' + user.device_id,
    pair.privateKey,
  );
  await call(user.access_token!, 'keys/upload', { device_keys: device });
  return { ...user, master, self, secret, device, pair };
}
async function query(token: string, user: string): Promise<Json> {
  return await call(token, 'keys/query', { device_keys: { [user]: [] } });
}
suite.test('public roles and private graph reach only authorized query and sync consumers', async () => {
  const a = await setup('sig-a'),
    b = await setup('sig-b'),
    c = await setup('sig-c');
  const beforeA = await call(a.access_token!, 'sync?timeout=0'),
    beforeB = await call(b.access_token!, 'sync?timeout=0');
  const device = structuredClone(a.device),
    ownMaster = structuredClone(a.master.json),
    otherMaster = structuredClone(b.master.json);
  await signJson(device, a.user_id, a.self.id, a.self.pair.privateKey);
  await signJson(
    ownMaster,
    a.user_id,
    'ed25519:' + a.device_id,
    a.pair.privateKey,
  );
  await signJson(otherMaster, a.user_id, a.secret.id, a.secret.pair.privateKey);
  assertEquals(
    await call(a.access_token!, 'keys/signatures/upload', {
      [a.user_id]: { [a.device_id]: device, [a.master.pub]: ownMaster },
      [b.user_id]: { [b.master.pub]: otherMaster },
    }),
    { failures: {} },
  );
  const own = await query(c.access_token!, a.user_id);
  assertEquals(
    (((own.device_keys as Json)[a.user_id] as Json)[a.device_id] as Json)
      .signatures,
    device.signatures,
  );
  assertEquals(
    ((own.master_keys as Json)[a.user_id] as Json).signatures,
    ownMaster.signatures,
  );
  assertEquals(
    ((await query(a.access_token!, b.user_id)).master_keys as Json)[b.user_id],
    { ...otherMaster },
  );
  for (const token of [b.access_token!, c.access_token!]) {
    assertEquals(
      (((await query(token, b.user_id)).master_keys as Json)[b.user_id] as Json)
        .signatures,
      {},
    );
  }
  const fed = fedCaller(suite.matrix, await remoteServer());
  const publicQuery = await fed(
    'POST',
    '/_matrix/federation/v1/user/keys/query',
    { device_keys: { [a.user_id]: [], [b.user_id]: [] } },
  );
  assertEquals(publicQuery.status, 200);
  assertEquals(
    ((publicQuery.body.master_keys as Json)[b.user_id] as Json).signatures,
    {},
  );
  assertEquals(
    ((publicQuery.body.master_keys as Json)[a.user_id] as Json).signatures,
    ownMaster.signatures,
  );
  const changedA = await call(
    a.access_token!,
    'sync?timeout=0&since=' + beforeA.next_batch,
  );
  assert(
    (changedA.device_lists as { changed: string[] }).changed.includes(
      b.user_id,
    ),
  );
  const changedB = await call(
    b.access_token!,
    'sync?timeout=0&since=' + beforeB.next_batch,
  );
  assertEquals((changedB.device_lists as { changed: string[] }).changed, []);
});

suite.test('per-target failures preserve valid entries and reject substitutions, forgery and wrong roles', async () => {
  const a = await setup('sig-invalid-a'), b = await setup('sig-invalid-b');
  const valid = structuredClone(a.device);
  await signJson(valid, a.user_id, a.self.id, a.self.pair.privateKey);
  const substituted = { ...b.master.json, extra: 'not the stored target' };
  await signJson(substituted, a.user_id, a.secret.id, a.secret.pair.privateKey);
  const result = await call(a.access_token!, 'keys/signatures/upload', {
    [a.user_id]: { [a.device_id]: valid },
    [b.user_id]: { [b.master.pub]: substituted, missing: b.master.json },
  });
  assertEquals(Object.keys(result.failures as Json), [b.user_id]);
  assertEquals(
    (((await query(b.access_token!, a.user_id)).device_keys as Json)[
      a.user_id
    ] as Json)[a.device_id] !== undefined,
    true,
  );
  const wrongRole = structuredClone(b.master.json);
  await signJson(wrongRole, a.user_id, a.self.id, a.self.pair.privateKey);
  for (
    const [targetUser, targetId, value] of [
      [a.user_id, a.master.pub, a.master.json],
      [a.user_id, a.device_id, {
        ...valid,
        signatures: { [a.user_id]: { [a.self.id]: 'forged' } },
      }],
      [b.user_id, b.master.pub, wrongRole],
    ] as [string, string, Json][]
  ) {
    const answer = await call(a.access_token!, 'keys/signatures/upload', {
      [targetUser]: { [targetId]: value },
    });
    assertEquals(
      ((answer.failures as Json)[targetUser] as Json)[targetId] !== undefined,
      true,
    );
  }
});

suite.test('retry is a no-op and signer/target incarnations cannot resurrect old overlays', async () => {
  const a = await setup('sig-life-a'), b = await setup('sig-life-b');
  const target = structuredClone(b.master.json);
  await signJson(target, a.user_id, a.secret.id, a.secret.pair.privateKey);
  const upload = { [b.user_id]: { [b.master.pub]: target } };
  assertEquals(await call(a.access_token!, 'keys/signatures/upload', upload), {
    failures: {},
  });
  const db = await theApp().store.tenant(theApp().tenant.serverName);
  const log = await db.query('SELECT * FROM e2ee_changes');
  assertEquals(await call(a.access_token!, 'keys/signatures/upload', upload), {
    failures: {},
  });
  assertEquals(await db.query('SELECT * FROM e2ee_changes'), log);
  const replacement = await key(b.user_id, 'master');
  for (const json of [replacement.json, b.master.json]) {
    const old = await theApp().tenant.tx((tx) =>
      tx.crossSigning.state(localpartOf(b.user_id))
    );
    await theApp().tenant.tx((tx) =>
      tx.crossSigning.upload(
        localpartOf(b.user_id),
        b.user_id,
        signingUpload({ master_key: json }, b.user_id, config().e2ee),
        canonicalJson(old),
        true,
      )
    );
  }
  assertEquals(
    (((await query(a.access_token!, b.user_id)).master_keys as Json)[
      b.user_id
    ] as Json).signatures,
    {},
  );
  const deviceSigned = structuredClone(a.master.json);
  await signJson(
    deviceSigned,
    a.user_id,
    'ed25519:' + a.device_id,
    a.pair.privateKey,
  );
  await call(a.access_token!, 'keys/signatures/upload', {
    [a.user_id]: { [a.master.pub]: deviceSigned },
  });
  await theApp().tenant.tx((tx) =>
    tx.devices.delete(a.device_id, localpartOf(a.user_id))
  );
  await theApp().tenant.tx((tx) =>
    tx.devices.upsert(a.device_id, localpartOf(a.user_id), null)
  );
  const login = await call(b.access_token!, 'login', {
    type: 'm.login.password',
    user: localpartOf(a.user_id),
    password: 'pw',
    device_id: a.device_id,
  });
  await call(login.access_token as string, 'keys/upload', {
    device_keys: a.device,
  });
  assertEquals(
    (((await query(b.access_token!, a.user_id)).master_keys as Json)[
      a.user_id
    ] as Json).signatures,
    {},
  );
  await deactivateUser(theApp().tenant, localpartOf(a.user_id));
  const response = await query(b.access_token!, a.user_id);
  assertEquals(response.master_keys, {});
  assertEquals(response.self_signing_keys, {});
  assertEquals(
    await db.query('SELECT * FROM key_signatures WHERE signer_localpart=?', [
      localpartOf(a.user_id),
    ]),
    [],
  );
  assertEquals(
    (((await query(b.access_token!, b.user_id)).master_keys as Json)[
      b.user_id
    ] as Json).signatures,
    {},
  );
});

suite.test('signature envelope admission is per target and retains independent private successes', async () => {
  const a = await setup('sig-budget-a'), b = await setup('sig-budget-b');
  const publicTarget = structuredClone(a.master.json),
    privateTarget = structuredClone(b.master.json);
  await signJson(
    publicTarget,
    a.user_id,
    'ed25519:' + a.device_id,
    a.pair.privateKey,
  );
  await signJson(
    privateTarget,
    a.user_id,
    a.secret.id,
    a.secret.pair.privateKey,
  );
  const previous = config().federation;
  try {
    setConfigForTests({ federation: { bulkmaxbytes: 100 } });
    const response = await call(a.access_token!, 'keys/signatures/upload', {
      [a.user_id]: { [a.master.pub]: publicTarget },
      [b.user_id]: { [b.master.pub]: privateTarget },
    });
    assertEquals(Object.keys(response.failures as Json), [a.user_id]);
  } finally {
    setConfigForTests({ federation: previous });
  }
  assertEquals(
    (((await query(b.access_token!, a.user_id)).master_keys as Json)[
      a.user_id
    ] as Json).signatures,
    {},
  );
  assertEquals(
    ((await query(a.access_token!, b.user_id)).master_keys as Json)[b.user_id],
    privateTarget,
  );
});
