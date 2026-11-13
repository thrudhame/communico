import { assert, assertEquals } from '@std/assert';
import { startHttp } from '#tests/http-app.ts';
import { fedCaller, remoteServer } from '#tests/http-federation.ts';
import { config, setConfigForTests } from '#engine/config.ts';
import { resetCaCertsForTests } from '#engine/federation/client.ts';
import { reconcileDeviceRoom } from '#engine/server/e2ee.ts';
import { startFakeServer } from '#tests/federation/fake-server.ts';
import { keyView } from '#engine/e2ee-key-view.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { wireSignature } from '#tests/fixtures/e2ee-wire.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

type Json = Record<string, unknown>;
async function signing(user: string) {
  const make = async (usage: string) => {
    const pair = await generateSigningKeypair() as CryptoKeyPair;
    const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
    return {
      pair,
      id: 'ed25519:' + pub,
      json: {
        user_id: user,
        usage: [usage],
        keys: { ['ed25519:' + pub]: pub },
      } as Json,
    };
  };
  const master = await make('master'), self = await make('self_signing');
  await signJson(self.json, user, master.id, master.pair.privateKey);
  master.json.signatures = {
    '@hidden:elsewhere': { 'ed25519:private': wireSignature },
  };
  return { master_key: master.json, self_signing_key: self.json };
}

Deno.test('remote signing: snapshot and query material reaches clients, EDU rotation preserves privacy and device completeness', async () => {
  const previous = config().federation;
  setConfigForTests({ federation: { cacerts: ['tests/fixtures/tls/ca.crt'] } });
  resetCaCertsForTests();
  const http = await startHttp();
  let user = '', snapshots = 0, queries = 0;
  let material: Json = {};
  const fake = await startFakeServer({
    ourKeyDoc: () =>
      Promise.resolve({
        server_name: http.app.tenant.serverName,
        verify_keys: {
          [http.app.tenant.keyId]: { key: http.app.tenant.publicB64 },
        },
      }),
    handlers: (req) => {
      if (req.path.includes('/user/devices/')) {
        snapshots++;
        return Response.json({
          user_id: user,
          stream_id: 10,
          devices: [],
          ...material,
        });
      }
      if (req.path.endsWith('/user/keys/query')) {
        queries++;
        return Response.json({
          device_keys: { [user]: {} },
          master_keys: { [user]: material.master_key },
          self_signing_keys: { [user]: material.self_signing_key },
          user_signing_keys: { [user]: { private: 'must not propagate' } },
        });
      }
      return null;
    },
  });
  user = '@bob:' + fake.name;
  try {
    const a = await http.registerTestUser('remote-sign-a', 'pw');
    const first = await signing(user), second = await signing(user);
    material = first;
    const query = async () => {
      const response = await http.matrix(
        new Request('http://x/_matrix/client/v3/keys/query', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + a.access_token },
          body: JSON.stringify({ device_keys: { [user]: [] } }),
        }),
      );
      assertEquals(response.status, 200);
      return await response.json();
    };
    const check = (body: Json, expected: Json) => {
      assertEquals(
        (body.master_keys as Json)[user],
        keyView(expected.master_key as Json, user, a.user_id),
      );
      assertEquals(
        (body.self_signing_keys as Json)[user],
        keyView(expected.self_signing_key as Json, user, a.user_id),
      );
      assertEquals(body.user_signing_keys, {});
    };
    // An untracked explicit query is not a complete-cache installation.
    check(await query(), first);
    assertEquals(queries, 1);
    await http.app.server.tx((tx) =>
      reconcileDeviceRoom(
        tx,
        '!sign:local',
        [a.user_id, user],
        false,
        null,
        1,
        [http.app.tenant.serverName],
      )
    );
    check(await query(), first);
    assertEquals(snapshots, 1);
    assertEquals(queries, 1);
    const sync = async (since = '') => {
      const response = await http.matrix(
        new Request(
          'http://x/_matrix/client/v3/sync?timeout=0' +
            (since ? '&since=' + since : ''),
          {
            headers: { authorization: 'Bearer ' + a.access_token },
          },
        ),
      );
      assertEquals(response.status, 200);
      return await response.json();
    };
    const call = fedCaller(http.matrix, await remoteServer(fake.name));
    const send = async (id: string, content: Json, status = 200) => {
      const response = await call('PUT', '/_matrix/federation/v1/send/' + id, {
        origin: fake.name,
        origin_server_ts: Date.now(),
        pdus: [],
        edus: [{ edu_type: 'm.signing_key_update', content }],
      });
      assertEquals(response.status, status);
    };
    const before = await sync();
    await send('rotate', {
      user_id: user,
      ...second,
      user_signing_key: { private: true },
    });
    check(await query(), second);
    assertEquals(
      snapshots,
      1,
      'signing rotation must not invalidate device completeness',
    );
    const changed = await sync(before.next_batch);
    assert(changed.device_lists.changed.includes(user));
    await send('duplicate', { user_id: user, ...second });
    await send('spoof', { user_id: a.user_id, ...second });
    const unshared = '@unshared:' + fake.name;
    await send('unshared', { user_id: unshared, ...await signing(unshared) });
    assertEquals(
      await http.app.server.query(
        'SELECT user_id FROM remote_signing_keys WHERE user_id=?',
        [unshared],
      ),
      [],
    );
    await send('forged-subordinate', {
      user_id: user,
      self_signing_key: first.self_signing_key,
    });
    check(await query(), second);
    assertEquals((await sync(changed.next_batch)).device_lists.changed, []);
    // A master-only rotation invalidates the obsolete subordinate, not devices.
    await send('master-only', { user_id: user, master_key: first.master_key });
    const rotated = await query();
    assertEquals(
      (rotated.master_keys as Json)[user],
      keyView(first.master_key, user, a.user_id),
    );
    assertEquals(rotated.self_signing_keys, {});
    // A persistence refusal cannot become a cached successful /send receipt.
    const db = http.app.server, original = db.tx;
    let injected = 0;
    db.tx = (fn, options) =>
      original(async (tx) => {
        const execute = tx.execute.bind(tx);
        tx.execute = (sql, values) => {
          if (sql.startsWith('INSERT INTO remote_signing_keys')) {
            injected++;
            throw new MatrixError(
              503,
              'M_UNKNOWN',
              'injected signing persistence failure',
            );
          }
          return execute(sql, values);
        };
        return await fn(tx);
      }, options);
    try {
      await send('persist-retry', { user_id: user, ...second }, 500);
      assertEquals(injected, 1);
    } finally {
      db.tx = original;
    }
    assertEquals(
      await db.query(
        "SELECT 1 FROM federation_txns WHERE txn_id='persist-retry'",
      ),
      [],
    );
    await send('persist-retry', { user_id: user, ...second });
    check(await query(), second);
    // One bad origin answer must preserve local success and expose no public subset.
    await http.app.server.tx((tx) =>
      reconcileDeviceRoom(tx, '!sign:local', [a.user_id], false, null, 2, [
        http.app.tenant.serverName,
      ])
    );
    material = { ...second, self_signing_key: first.self_signing_key };
    const invalid = await query();
    assert((invalid.failures as Json)[fake.name]);
    assertEquals(invalid.master_keys, {});
    assertEquals(invalid.self_signing_keys, {});
  } finally {
    await http.close();
    await fake.close();
    setConfigForTests({ federation: previous });
    resetCaCertsForTests();
  }
});
