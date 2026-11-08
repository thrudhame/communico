import { assert, assertEquals } from '@std/assert';
import { httpSuite } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { theApp } from '#engine/app.ts';
import { localpartOf } from '#engine/ids.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { withRemoteSigningState } from '#engine/server/remote-devices.ts';
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

suite.test('remote master overlays stay private and reject signer or target changes during resolution', async () => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const a = await setup('sig-remote-a'), c = await setup('sig-remote-c');
  let user = '', master: Awaited<ReturnType<typeof key>>;
  let entered: (() => void) | undefined, release: Promise<void> | undefined;
  let queries = 0;
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: theApp().tenant.serverName,
        verify_keys: {
          [theApp().tenant.keyId]: { key: theApp().tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (req.path.includes('/user/devices/')) {
        return Response.json({
          user_id: user,
          stream_id: 1,
          devices: [],
          master_key: master.json,
        });
      }
      if (!req.path.endsWith('/user/keys/query')) return null;
      queries++;
      const answer = {
        device_keys: { [user]: {} },
        master_keys: { [user]: master.json },
      };
      if (!release) return Response.json(answer);
      entered?.();
      return release.then(() => Response.json(answer));
    },
  });
  user = '@remote:' + fake.name;
  try {
    master = await key(user, 'master');
    const signed = structuredClone(master.json);
    await signJson(signed, a.user_id, a.secret.id, a.secret.pair.privateKey);
    const body = { [user]: { [master.pub]: signed } };
    const beforeA = await call(a.access_token!, 'sync?timeout=0');
    const beforeC = await call(c.access_token!, 'sync?timeout=0');
    assertEquals(await call(a.access_token!, 'keys/signatures/upload', body), {
      failures: {},
    });
    assertEquals(
      ((await query(a.access_token!, user)).master_keys as Json)[user],
      signed,
    );
    assertEquals(
      (((await query(c.access_token!, user)).master_keys as Json)[user] as Json)
        .signatures,
      {},
    );
    assert(
      ((await call(
        a.access_token!,
        'sync?timeout=0&since=' + beforeA.next_batch,
      )).device_lists as { changed: string[] }).changed.includes(user),
    );
    assertEquals(
      ((await call(
        c.access_token!,
        'sync?timeout=0&since=' + beforeC.next_batch,
      )).device_lists as Json).changed,
      [],
    );
    const db = await theApp().store.tenant(theApp().tenant.serverName);
    const rows = await db.query(
      'SELECT * FROM key_signatures WHERE target_user=?',
      [user],
    );
    assertEquals(rows.length, 1);
    // An unavailable target fails only its own entry, never the local success.
    const publicTarget = structuredClone(a.device);
    await signJson(publicTarget, a.user_id, a.self.id, a.self.pair.privateKey);
    const partial = await call(a.access_token!, 'keys/signatures/upload', {
      [a.user_id]: { [a.device_id]: publicTarget },
      [user]: { missing: signed },
    });
    assert((partial.failures as Json)[user]);
    assertEquals(
      ((((await query(c.access_token!, a.user_id)).device_keys as Json)[
        a.user_id
      ] as Json)[a.device_id] as Json).signatures,
      publicTarget.signatures,
    );
    // Rotation away and back to the same signer bytes still invalidates the basis.
    let unblock!: () => void;
    release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pending = call(a.access_token!, 'keys/signatures/upload', body);
    let timeout!: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        reached,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error('remote resolution did not dial')),
            3000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    const replacement = await key(a.user_id, 'user_signing');
    await signJson(
      replacement.json,
      a.user_id,
      a.master.id,
      a.master.pair.privateKey,
    );
    for (const secret of [replacement.json, a.secret.json]) {
      const old = await theApp().tenant.tx((tx) =>
        tx.crossSigning.state(localpartOf(a.user_id))
      );
      await theApp().tenant.tx((tx) =>
        tx.crossSigning.upload(
          localpartOf(a.user_id),
          a.user_id,
          signingUpload({ user_signing_key: secret }, a.user_id, config().e2ee),
          canonicalJson(old),
          true,
        )
      );
    }
    unblock();
    assert(((await pending).failures as Json)[user]);
    assertEquals(
      (((await query(a.access_token!, user)).master_keys as Json)[user] as Json)
        .signatures,
      {},
    );
    release = undefined;
    // A concurrent authoritative target rotation rejects a previously fetched cut.
    release = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const targetReached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const targetPending = call(a.access_token!, 'keys/signatures/upload', body);
    await targetReached;
    await theApp().server.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!sigremote:local',
        [a.user_id, user],
        false,
        null,
        1,
        [theApp().tenant.serverName],
      )
    );
    const remote = fedCaller(suite.matrix, await remoteServer(fake.name));
    const changed = await key(user, 'master');
    const sent = await remote(
      'PUT',
      '/_matrix/federation/v1/send/signature-rotation',
      {
        origin: fake.name,
        origin_server_ts: Date.now(),
        pdus: [],
        edus: [{
          edu_type: 'm.signing_key_update',
          content: { user_id: user, master_key: changed.json },
        }],
      },
    );
    assertEquals(sent.status, 200);
    unblock();
    assert(((await targetPending).failures as Json)[user]);
    assertEquals(
      (await db.query('SELECT * FROM key_signatures WHERE target_user=?', [
        user,
      ])).length,
      0,
    );
    assert(queries >= 4);
    release = undefined;
    master = changed;
    // The complete-cache path merges the same requester-owned overlay, without
    // copying it into shared cache material or initiating another origin query.
    await query(a.access_token!, user);
    const cacheSigned = structuredClone(master.json);
    await signJson(
      cacheSigned,
      a.user_id,
      a.secret.id,
      a.secret.pair.privateKey,
    );
    const cachedBody = { [user]: { [master.pub]: cacheSigned } };
    const beforeQueries = queries;
    assertEquals(
      await call(a.access_token!, 'keys/signatures/upload', cachedBody),
      { failures: {} },
    );
    assertEquals(
      ((await query(a.access_token!, user)).master_keys as Json)[user],
      cacheSigned,
    );
    assertEquals(
      (((await query(c.access_token!, user)).master_keys as Json)[user] as Json)
        .signatures,
      {},
    );
    assertEquals(queries, beforeQueries);
    let releaseLock!: () => void, lockEntered!: () => void;
    const locked = new Promise<void>((resolve) => {
      lockEntered = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const protectedRead = withRemoteSigningState(
      theApp().server,
      user,
      async () => {
        lockEntered();
        await hold;
      },
    );
    await locked;
    try {
      const started = performance.now();
      const timed = await call(a.access_token!, 'keys/query', {
        timeout: 50,
        device_keys: { [user]: [] },
      });
      assert(
        performance.now() - started < 500,
        'signing serialization must honor the query deadline',
      );
      assert((timed.failures as Json)[fake.name]);
    } finally {
      releaseLock();
      await protectedRead;
    }
    const plain = await query(c.access_token!, user);
    try {
      setConfigForTests({
        federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
        e2ee: {
          maxrequestbytes:
            new TextEncoder().encode(JSON.stringify(plain)).length + 20,
        },
      });
      const limited = await query(a.access_token!, user);
      assert((limited.failures as Json)[fake.name]);
      assertEquals(limited.master_keys, {});
    } finally {
      setConfigForTests({
        federation: { cacerts: ['tests/fixtures/tls/ca.crt'] },
      });
    }
    const learned = await theApp().server.query(
      'SELECT payload FROM remote_signing_keys WHERE user_id=?',
      [user],
    );
    assert(!String(learned[0].payload).includes(a.user_id));
    const publicView = await remote(
      'POST',
      '/_matrix/federation/v1/user/keys/query',
      { device_keys: { [user]: [] } },
    );
    assertEquals(
      publicView.status,
      400,
      'federation serving remains own-domain only',
    );
    assert(!JSON.stringify(publicView.body).includes(a.secret.id));
    const next = await key(user, 'master');
    for (
      const [id, json] of [['away', next.json], ['back', master.json]] as [
        string,
        Json,
      ][]
    ) {
      assertEquals(
        (await remote(
          'PUT',
          '/_matrix/federation/v1/send/remote-overlay-' + id,
          {
            origin: fake.name,
            origin_server_ts: Date.now(),
            pdus: [],
            edus: [{
              edu_type: 'm.signing_key_update',
              content: { user_id: user, master_key: json },
            }],
          },
        )).status,
        200,
      );
    }
    assertEquals(
      (((await query(a.access_token!, user)).master_keys as Json)[user] as Json)
        .signatures,
      {},
    );
  } finally {
    await fake.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});
