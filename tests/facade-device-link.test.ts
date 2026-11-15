import { assert, assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
  exportSessionAuthority,
} from '#engine/facade/accounts.ts';
import { DeviceOperations, type DeviceView } from '#engine/facade/devices.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { bindRole } from '#engine/facade/role.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  recordHash,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { updateDeviceName, upsertDevice } from '#engine/tenant/devices.ts';
import { publicDeviceValues } from '#engine/tenant/device-operations.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { validateUpload } from '#engine/tenant/e2ee.ts';
import type { Conn } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { captureSigningOperations } from '#engine/tenant/signing-operations.ts';
import { captureSignatureOperations } from '#engine/tenant/signature-operations.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import {
  b64encodeStd,
  exportPublicKeyRaw,
  generateSigningKeypair,
  signJson,
} from '#engine/signing-primitives.js';

// Pause the real owner at deterministic cross-file boundaries. Revocation runs
// in the test task, never as a nested server transaction in the owner callback.
function pauseImport(store: Store, cut: 'before' | 'during' | 'after') {
  const reached = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const tenant = store.tenant.bind(store);
  let paused = false;
  const pause = async () => {
    if (paused) return;
    paused = true;
    reached.resolve();
    await proceed.promise;
  };
  store.tenant = async (...args) => {
    const db = await tenant(...args);
    return {
      ...db,
      tx: async (fn, options) => {
        let imported = false;
        const result = await db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, key) {
                if (key === 'query') {
                  return async (...args: Parameters<Conn['query']>) => {
                    const [sql] = args;
                    if (
                      cut === 'before' &&
                      sql.includes('facade_owner_activation')
                    ) await pause();
                    return await target.query(...args);
                  };
                }
                if (key === 'execute') {
                  return async (...args: Parameters<Conn['execute']>) => {
                    const value = await target.execute(...args);
                    if (
                      args[0].startsWith('INSERT INTO device_operations ') ||
                      args[0].startsWith('INSERT INTO signing_operations ') ||
                      args[0].startsWith('INSERT INTO signature_operations ')
                    ) {
                      imported = true;
                      if (cut === 'during') await pause();
                    }
                    return value;
                  };
                }
                const value = Reflect.get(target, key);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options);
        if (imported && cut === 'after') await pause();
        return result;
      },
    };
  };
  return {
    reached: reached.promise,
    resume: () => proceed.resolve(),
    restore: () => {
      store.tenant = tenant;
    },
  };
}

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-device-link-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  await bindRole(home, { role: 'home', server: 'logical.test', node: '' });
  await bindRole(edge, {
    role: 'facade',
    server: 'logical.test',
    node: 'edge_a',
  });
  const ht = await openTenant(home, 'logical.test', { create: true });
  await ht.tx(async (tx) => {
    await tx.users.insert('alice', 'Alice');
    await tx.users.insert('bob', 'Bob');
  });
  await upsertDevice(ht, 'alice', 'LAN', 'home name');
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    ht.signer(),
    ht.publicB64,
    'a'.repeat(64),
  );
  const fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  const bundle = await hp.create({
    node: 'edge_a',
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  await hp.confirm(
    bundle.id,
    await fp.complete(
      bundle.id,
      await hp.grant(
        bundle.id,
        await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
      ),
      'a'.repeat(64),
    ),
  );
  const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const hj = new Journal(await home.server(), LINK_SUPPORTED),
    ej = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const control = await exportOwnerControl(home, ht, hp, bundle.id);
  await ej.receive('home', [control]);
  await owners.apply(ej, control);
  const accounts = new AccountSnapshots(home, ht, hp);
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await ej.receive('home', [auth]);
  await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  return {
    open,
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    node,
    bundle,
    hj,
    ej,
    owners,
    accounts,
    hs: new DeviceOperations(home, ht, hp),
    es: new DeviceOperations(edge, et, fp, node),
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function signingInput() {
  const user = '@alice:logical.test';
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  const input: Record<string, unknown> = {
    master_key: {
      user_id: user,
      usage: ['master'],
      keys: { ['ed25519:' + pub]: pub },
    },
  };
  for (const usage of ['self_signing', 'user_signing']) {
    const subordinate = await generateSigningKeypair() as CryptoKeyPair;
    const key = b64encodeStd(await exportPublicKeyRaw(subordinate.publicKey));
    const json = {
      user_id: user,
      usage: [usage],
      keys: { ['ed25519:' + key]: key },
    };
    await signJson(json, user, 'ed25519:' + pub, pair.privateKey);
    input[usage + '_key'] = json;
  }
  return signingUpload(input, user, config().e2ee);
}

async function signatureInput(
  f: Awaited<ReturnType<typeof fixture>>,
  side: 'home' | 'edge' = 'home',
) {
  const tenant = side === 'home' ? f.ht : f.et;
  const deviceId = side === 'home' ? 'LAN' : 'PHONE';
  const user = '@alice:logical.test';
  const pair = await generateSigningKeypair() as CryptoKeyPair;
  const pub = b64encodeStd(await exportPublicKeyRaw(pair.publicKey));
  await upsertDevice(tenant, 'alice', deviceId);
  const device = await deviceIdentity(tenant, 'alice', deviceId);
  await tenant.tx((tx) =>
    tx.e2ee.upload(
      device,
      validateUpload(
        {
          device_keys: {
            user_id: user,
            device_id: deviceId,
            algorithms: [],
            keys: { ['ed25519:' + deviceId]: pub },
            signatures: {},
          },
        },
        user,
        deviceId,
        config().e2ee,
      ),
    )
  );
  const input = await signingInput();
  await f.ht.tx((tx) =>
    tx.crossSigning.upload('alice', user, input, '{}', false)
  );
  if (side === 'edge') {
    const records = await f.hs.exportSigning('alice', f.bundle.id);
    await f.ej.receive('home', records);
    for (const record of records) await f.es.apply(f.ej, record);
  }
  const master = JSON.parse(input.master!.json);
  const id = Object.values(master.keys as Record<string, string>)[0];
  await signJson(master, user, 'ed25519:' + deviceId, pair.privateKey);
  assertEquals(
    await tenant.tx((tx) =>
      tx.keySignatures.upload('alice', user, [{
        user,
        id,
        json: master,
      }])
    ),
    { failures: {} },
  );
  const db = await (side === 'home' ? f.home : f.edge).tenant('logical.test');
  const [operation] = await db.tx((conn) =>
    captureSignatureOperations(conn, 'alice')
  );
  assert(operation);
  return operation;
}

Deno.test('signature link: a signed portable overlay is applied before its journal ACK', async () => {
  const f = await fixture();
  try {
    const operation = await signatureInput(f);
    const [template] = await f.hs.export('alice', f.bundle.id);
    const view = {
      ...(template.payload as { body: DeviceView }).body,
      kind: 'signature-operation',
      operation,
    };
    const body = {
      ...template,
      stream: 'signatures:@alice:logical.test',
      type: 'signature-operation',
      operationId: 'signature:' + createHash('sha256').update(canonicalJson([
        f.bundle.id,
        view.grantRevision,
        view.ownerRevision,
        operation.operationId,
      ])).digest('hex'),
      payload: {
        body: view,
        signature: await f.ht.signer().sign(canonicalJson(view)),
      },
    };
    const { hash: _hash, ...unsigned } = body;
    const record = { ...unsigned, hash: recordHash(unsigned) };
    const journal = new Journal(await f.edge.server(), [...LINK_SUPPORTED, {
      type: 'signature-operation',
      version: 1,
    }]);
    await journal.receive('home', [record]);
    assertEquals(await f.es.apply(journal, record), true);
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT payload_json FROM signature_operations',
      )).map((row) => JSON.parse(String(row.payload_json))),
      [operation],
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.hash,
      record.hash,
    );
  } finally {
    await f.close();
  }
});

Deno.test('signature link: both selected sources export original overlays without echo or device/pool authority', async () => {
  for (const side of ['home', 'edge'] as const) {
    const f = await fixture();
    try {
      const operation = await signatureInput(f, side);
      const owner = side === 'home' ? f.hs : f.es;
      const receiver = side === 'home' ? f.es : f.hs;
      const journal = side === 'home' ? f.ej : f.hj;
      const peer = side === 'home' ? 'home' : 'edge_a';
      const records = await owner.exportSignatures(
        'alice',
        side === 'home' ? f.bundle.id : undefined,
      );
      assertEquals(records.length, 1);
      assertEquals(records[0].type, 'signature-operation');
      assertEquals(records[0].stream, 'signatures:@alice:logical.test');
      assertEquals(
        await owner.exportSignatures(
          'alice',
          side === 'home' ? f.bundle.id : undefined,
        ),
        records,
      );
      await journal.receive(peer, records);
      assertEquals(
        await receiver.apply(
          journal,
          records[0],
          side === 'edge' ? f.bundle.id : undefined,
        ),
        true,
      );
      assertEquals(
        await receiver.apply(
          journal,
          records[0],
          side === 'edge' ? f.bundle.id : undefined,
        ),
        false,
      );
      const db = await (side === 'home' ? f.edge : f.home).tenant(
        'logical.test',
      );
      assertEquals(
        (await db.query('SELECT payload_json FROM signature_operations')).map((
          row,
        ) => JSON.parse(String(row.payload_json))),
        [operation],
      );
      assertEquals(
        await receiver.exportSignatures(
          'alice',
          side === 'edge' ? f.bundle.id : undefined,
        ),
        [],
      );
      assertEquals(await db.query('SELECT * FROM device_operations'), []);
      assertEquals(await db.query('SELECT * FROM one_time_keys'), []);
      await assertRejects(
        () =>
          owner.exportSignatures(
            'bob',
            side === 'home' ? f.bundle.id : undefined,
          ),
        Error,
        'account not selected',
      );
    } finally {
      await f.close();
    }
  }
  assert(
    LINK_SUPPORTED.some((cap) =>
      cap.type === 'signature-operation' && cap.version === 1
    ),
  );
  assertEquals(
    LINK_CAPABILITIES.some((cap) => cap.type === 'signature-operation'),
    false,
  );
});

Deno.test('signature link: changed signed scope, type or bytes never imports or ACKs an overlay', async () => {
  for (
    const fault of [
      'signature',
      'source',
      'localpart',
      'grantRevision',
      'stream',
      'type',
    ] as const
  ) {
    const f = await fixture();
    try {
      await signatureInput(f);
      const [record] = await f.hs.exportSignatures('alice', f.bundle.id);
      const signed = record.payload as {
        body: Record<string, unknown>;
        signature: string;
      };
      if (fault === 'signature') signed.signature = 'A'.repeat(86);
      else if (fault === 'stream') {
        record.stream = 'signing:@alice:logical.test';
      } else if (fault === 'type') record.type = 'signing-operation';
      else {
        signed.body[fault] = fault === 'source'
          ? 'edge_a'
          : fault === 'localpart'
          ? 'bob'
          : Number(signed.body.grantRevision) + 1;
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      const { hash: _hash, ...body } = record;
      record.hash = recordHash(body);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM signature_operations',
        ),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signature link: current control, selection and pairing fence overlay admission', async () => {
  for (const fault of ['control', 'selection', 'revoked'] as const) {
    const f = await fixture();
    try {
      await signatureInput(f);
      const [record] = await f.hs.exportSignatures('alice', f.bundle.id);
      await f.ej.receive('home', [record]);
      const db = await f.edge.tenant('logical.test');
      if (fault === 'control') {
        await db.tx((conn) =>
          conn.execute('DELETE FROM facade_owner_activation')
        );
      } else if (fault === 'selection') {
        await db.tx((conn) =>
          conn.execute(
            'UPDATE account_auth_snapshots SET grant_revision=grant_revision+1',
          )
        );
      } else await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(await db.query('SELECT * FROM signature_operations'), []);
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signature link: revocation before or during overlay admission rolls back fact and receipt', async () => {
  for (const side of ['home', 'edge'] as const) {
    for (const cut of ['before', 'during'] as const) {
      const f = await fixture();
      try {
        await signatureInput(f, side === 'home' ? 'edge' : 'home');
        const records = side === 'home'
          ? await f.es.exportSignatures('alice')
          : await f.hs.exportSignatures('alice', f.bundle.id);
        const store = side === 'home' ? f.home : f.edge;
        const owner = side === 'home' ? f.hs : f.es;
        const journal = side === 'home' ? f.hj : f.ej;
        const peer = side === 'home' ? 'edge_a' : 'home';
        await journal.receive(peer, records);
        const paused = pauseImport(store, cut);
        const outcome = owner.apply(
          journal,
          records[0],
          side === 'home' ? f.bundle.id : undefined,
        ).then(() => null, (error) => error);
        try {
          await Promise.race([
            paused.reached,
            outcome.then((error) => {
              throw error ??
                new Error('overlay admission did not reach its cut');
            }),
          ]);
          const revoked = await f.hp.revoke(f.bundle.id);
          if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
        } finally {
          paused.resume();
          paused.restore();
        }
        assert(await outcome instanceof Error);
        const db = await store.tenant('logical.test');
        assertEquals(await db.query('SELECT * FROM signature_operations'), []);
        assertEquals(
          await db.query('SELECT * FROM facade_link_applications'),
          [],
        );
        assertEquals(
          (await journal.next(peer, records[0]))?.hash,
          records[0].hash,
        );
      } finally {
        await f.close();
      }
    }
  }
});

Deno.test('signature link: admitted overlay survives retirement and ACK loss across actual cold reopen', async () => {
  for (const side of ['home', 'edge'] as const) {
    const f = await fixture();
    try {
      await signatureInput(f, side === 'home' ? 'edge' : 'home');
      const records = side === 'home'
        ? await f.es.exportSignatures('alice')
        : await f.hs.exportSignatures('alice', f.bundle.id);
      const store = side === 'home' ? f.home : f.edge;
      const owner = side === 'home' ? f.hs : f.es;
      const journal = side === 'home' ? f.hj : f.ej;
      const peer = side === 'home' ? 'edge_a' : 'home';
      await journal.receive(peer, records);
      const paused = pauseImport(store, 'after');
      journal.complete = () =>
        Promise.reject(new Error('injected signature ACK loss'));
      const outcome = owner.apply(
        journal,
        records[0],
        side === 'home' ? f.bundle.id : undefined,
      ).then(() => null, (error) => error);
      try {
        await Promise.race([
          paused.reached,
          outcome.then((error) => {
            throw error ?? new Error('overlay admission did not reach its cut');
          }),
        ]);
        const revoked = await f.hp.revoke(f.bundle.id);
        if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      const error = await outcome;
      assert(
        error instanceof Error &&
          error.message === 'injected signature ACK loss',
      );
      await store.close();
      const reopened = await f.open(side);
      try {
        const pairings = side === 'edge'
          ? new Pairings(
            await reopened.server(),
            f.node.signer(),
            f.node.publicKey,
            'b'.repeat(64),
            f.node,
          )
          : new Pairings(
            await reopened.server(),
            f.ht.signer(),
            f.ht.publicB64,
            'a'.repeat(64),
          );
        const coldJournal = new Journal(
          await reopened.server(),
          LINK_SUPPORTED,
        );
        const coldOwner = new DeviceOperations(
          reopened,
          side === 'edge' ? f.et : f.ht,
          pairings,
          side === 'edge' ? f.node : undefined,
        );
        assertEquals(
          await coldOwner.apply(
            coldJournal,
            records[0],
            side === 'home' ? f.bundle.id : undefined,
          ),
          true,
        );
        assertEquals(
          (await coldJournal.heads(peer, 'in', records[0])).applied.hash,
          records[0].hash,
        );
        assertEquals(
          (await (await reopened.tenant('logical.test')).query(
            'SELECT * FROM signature_operations',
          )).length,
          1,
        );
        assertEquals(
          await coldOwner.apply(
            coldJournal,
            records[0],
            side === 'home' ? f.bundle.id : undefined,
          ),
          false,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test('device link: current owner facts cross the signed journal without granting mutable authority or echoing', async () => {
  const f = await fixture();
  try {
    const records = await f.hs.export('alice', f.bundle.id);
    assert(records.length > 0, 'home public device intent must reach the link');
    for (const record of records) {
      await f.ej.receive('home', [record]);
      assertEquals(await f.es.apply(f.ej, record), true);
    }
    const db = await f.edge.tenant('logical.test');
    assertEquals(
      (await db.tx((conn) => publicDeviceValues(conn, 'alice'))).map((
        op,
      ) => [op.deviceId, op.value?.displayName]),
      [['LAN', 'home name']],
    );
    assertEquals(await db.query('SELECT * FROM devices'), []);
    assertEquals(await f.es.export('alice'), []);
    await upsertDevice(f.et, 'alice', 'PHONE', 'outside name');
    await updateDeviceName(f.et, 'alice', 'PHONE', 'renamed outside');
    const authority = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    await f.hj.receive('edge_a', [authority]);
    await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
    const device = await deviceIdentity(f.et, 'alice', 'PHONE');
    await f.et.tx((tx) =>
      tx.e2ee.upload(
        device,
        validateUpload(
          {
            device_keys: {
              user_id: '@alice:logical.test',
              device_id: 'PHONE',
              algorithms: [],
              keys: { 'ed25519:PHONE': 'public-owner-key' },
              signatures: {},
            },
            one_time_keys: { 'curve25519:secret': 'private-pool-material' },
            fallback_keys: { 'curve25519:secret': 'fallback-pool-material' },
          },
          '@alice:logical.test',
          'PHONE',
          config().e2ee,
        ),
      )
    );
    const reverse = await f.es.export('alice');
    assertEquals(
      JSON.stringify(reverse).includes('private-pool-material'),
      false,
    );
    assertEquals(
      JSON.stringify(reverse).includes('fallback-pool-material'),
      false,
    );
    assert(reverse.length > 0, 'facade public intent must be pulled by home');
    for (const record of reverse) {
      await f.hj.receive('edge_a', [record]);
      assertEquals(await f.hs.apply(f.hj, record, f.bundle.id), true);
    }
    const hdb = await f.home.tenant('logical.test');
    assertEquals(
      (await hdb.tx((conn) => publicDeviceValues(conn, 'alice'))).map((
        op,
      ) => [op.deviceId, op.value?.displayName]),
      [['LAN', 'home name'], ['PHONE', 'renamed outside']],
    );
    assertEquals(
      (await hdb.query('SELECT device_id FROM devices')).map((row) =>
        row.device_id
      ),
      ['LAN'],
    );
    assertEquals(await f.hs.export('alice', f.bundle.id), records);
    assertEquals(
      (await hdb.tx((conn) => publicDeviceValues(conn, 'alice'))).find((op) =>
        op.deviceId === 'PHONE'
      )?.value?.keys?.keys,
      { 'ed25519:PHONE': 'public-owner-key' },
    );
    assertEquals(await f.hs.apply(f.hj, reverse[0], f.bundle.id), false);
  } finally {
    await f.close();
  }
});

Deno.test('device link: reader negotiation does not change F1 required capabilities', () => {
  assertEquals(
    LINK_SUPPORTED.some((cap) =>
      cap.type === 'device-operation' && cap.version === 1
    ),
    true,
  );
  assertEquals(
    LINK_CAPABILITIES.some((cap) => cap.type === 'device-operation'),
    false,
  );
});

Deno.test('signing link: an enrolled home-signed complete identity reaches the tenant before its journal ACK', async () => {
  const f = await fixture();
  try {
    const [template] = await f.hs.export('alice', f.bundle.id);
    const [operation] = await (await f.home.tenant('logical.test')).tx((conn) =>
      captureSigningOperations(conn, 'alice')
    );
    const view = {
      ...(template.payload as { body: DeviceView }).body,
      kind: 'signing-operation',
      operation,
    };
    const body = {
      ...template,
      stream: 'signing:@alice:logical.test',
      type: 'signing-operation',
      operationId: 'signing:' + createHash('sha256').update(canonicalJson([
        f.bundle.id,
        view.grantRevision,
        view.ownerRevision,
        operation.operationId,
      ])).digest('hex'),
      payload: {
        body: view,
        signature: await f.ht.signer().sign(canonicalJson(view)),
      },
    };
    const { hash: _hash, ...unsigned } = body;
    const record = { ...unsigned, hash: recordHash(unsigned) };
    const journal = new Journal(await f.edge.server(), [
      ...LINK_SUPPORTED,
      { type: 'signing-operation', version: 1 },
    ]);
    await journal.receive('home', [record]);
    assertEquals(await f.es.apply(journal, record), true);
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT payload_json FROM signing_operations',
      )).map((row) => JSON.parse(String(row.payload_json))),
      [operation],
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.hash,
      record.hash,
    );
  } finally {
    await f.close();
  }
});

Deno.test('signing link: selected home identity export is stable and own-user scoped, never edge-authored or a mutable device', async () => {
  const f = await fixture();
  const user = '@alice:logical.test';
  try {
    const input = await signingInput();
    await f.ht.tx((tx) =>
      tx.crossSigning.upload('alice', user, input, '{}', false)
    );
    const records = await f.hs.exportSigning('alice', f.bundle.id);
    assertEquals(records.length, 1);
    assertEquals(records[0].type, 'signing-operation');
    assertEquals(records[0].stream, 'signing:@alice:logical.test');
    assertEquals(await f.hs.exportSigning('alice', f.bundle.id), records);
    await f.ej.receive('home', records);
    assertEquals(await f.es.apply(f.ej, records[0]), true);
    assertEquals(await f.es.apply(f.ej, records[0]), false);
    assertEquals(await f.et.tx((tx) => tx.crossSigning.state('alice')), input);
    const own = await f.et.tx((tx) =>
      tx.crossSigning.views('alice', user, user)
    );
    const other = await f.et.tx((tx) =>
      tx.crossSigning.views('alice', user, '@bob:logical.test')
    );
    assert(own.user_signing_keys);
    assertEquals(other.user_signing_keys, undefined);
    assertEquals(await f.es.exportSigning('alice'), []);
    assertEquals(
      await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM devices',
      ),
      [],
    );
    assertEquals(
      LINK_SUPPORTED.some((cap) =>
        cap.type === 'signing-operation' && cap.version === 1
      ),
      true,
    );
    assertEquals(
      LINK_CAPABILITIES.some((cap) => cap.type === 'signing-operation'),
      false,
    );
    for (
      const [owner, pairing] of [[f.hs, f.bundle.id], [
        f.es,
        undefined,
      ]] as const
    ) {
      await assertRejects(
        () => owner.exportSigning('bob', pairing),
        Error,
        'account not selected',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('signing link: forged signature, source, account, grant, stream or record kind cannot gain an identity or ACK', async () => {
  for (
    const fault of [
      'signature',
      'source',
      'localpart',
      'grantRevision',
      'stream',
      'type',
    ] as const
  ) {
    const f = await fixture();
    try {
      const [record] = await f.hs.exportSigning('alice', f.bundle.id);
      const signed = record.payload as {
        body: Record<string, unknown>;
        signature: string;
      };
      if (fault === 'signature') signed.signature = 'A'.repeat(86);
      else if (fault === 'stream') {
        record.stream = 'devices:@alice:logical.test';
      } else if (fault === 'type') record.type = 'device-operation';
      else {
        signed.body[fault] = fault === 'source'
          ? 'edge_a'
          : fault === 'localpart'
          ? 'bob'
          : Number(signed.body.grantRevision) + 1;
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      const { hash: _hash, ...body } = record;
      record.hash = recordHash(body);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM signing_operations',
        ),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signing link: tenant control, account selection and live pairing fence identity import', async () => {
  for (const fault of ['control', 'selection', 'revoked'] as const) {
    const f = await fixture();
    try {
      const [record] = await f.hs.exportSigning('alice', f.bundle.id);
      await f.ej.receive('home', [record]);
      const tenant = await f.edge.tenant('logical.test');
      if (fault === 'control') {
        await tenant.tx((conn) =>
          conn.execute('DELETE FROM facade_owner_activation')
        );
      } else if (fault === 'selection') {
        await tenant.tx((conn) =>
          conn.execute(
            'UPDATE account_auth_snapshots SET grant_revision=grant_revision+1',
          )
        );
      } else await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(await tenant.query('SELECT * FROM signing_operations'), []);
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signing link: revocation before or during identity admission rolls back both fact and receipt', async () => {
  for (const cut of ['before', 'during'] as const) {
    const f = await fixture();
    try {
      const [record] = await f.hs.exportSigning('alice', f.bundle.id);
      await f.ej.receive('home', [record]);
      const paused = pauseImport(f.edge, cut);
      const outcome = f.es.apply(f.ej, record).then(
        () => null,
        (error) => error,
      );
      try {
        await paused.reached;
        await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      assert(await outcome instanceof Error);
      const tenant = await f.edge.tenant('logical.test');
      assertEquals(await tenant.query('SELECT * FROM signing_operations'), []);
      assertEquals(
        await tenant.query('SELECT * FROM facade_link_applications'),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});

Deno.test('signing link: admitted identity survives retirement and ACK loss with exact cold completion only', async () => {
  const f = await fixture();
  try {
    await f.hs.exportSigning('alice', f.bundle.id);
    await f.ht.tx(async (tx) =>
      tx.crossSigning.upload(
        'alice',
        '@alice:logical.test',
        await signingInput(),
        '{}',
        false,
      )
    );
    const records = await f.hs.exportSigning('alice', f.bundle.id);
    assertEquals(records.length, 2);
    await f.ej.receive('home', records);
    const paused = pauseImport(f.edge, 'after');
    f.ej.complete = () =>
      Promise.reject(new Error('injected signing ACK loss'));
    const outcome = f.es.apply(f.ej, records[0]).then(
      () => null,
      (error) => error,
    );
    try {
      await paused.reached;
      await f.fp.retire(await f.hp.revoke(f.bundle.id), 'a'.repeat(64));
    } finally {
      paused.resume();
      paused.restore();
    }
    const error = await outcome;
    assert(
      error instanceof Error && error.message === 'injected signing ACK loss',
    );
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const pairings = new Pairings(
        await reopened.server(),
        f.node.signer(),
        f.node.publicKey,
        'b'.repeat(64),
        f.node,
      );
      const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
      const owner = new DeviceOperations(reopened, f.et, pairings, f.node);
      assertEquals(await owner.apply(journal, records[0]), true);
      assertEquals(
        (await journal.heads('home', 'in', records[0])).applied.hash,
        records[0].hash,
      );
      assertEquals(
        (await (await reopened.tenant('logical.test')).query(
          'SELECT * FROM signing_operations',
        )).length,
        1,
      );
      await assertRejects(() => owner.apply(journal, records[1]), Error);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: missing incarnation cannot ACK and resumes only after authentic authority arrives', async () => {
  const f = await fixture();
  try {
    await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
    const records = await f.es.export('alice');
    assert(records.length > 0);
    await f.hj.receive('edge_a', records);
    await assertRejects(
      () => f.hs.apply(f.hj, records[0], f.bundle.id),
      Error,
      'awaits incarnation',
    );
    assertEquals(
      await (await f.home.tenant('logical.test')).query(
        'SELECT * FROM device_operations',
      ),
      [],
    );
    assertEquals(
      (await f.hj.next('edge_a', records[0]))?.hash,
      records[0].hash,
    );
    const authority = await exportSessionAuthority(
      f.edge,
      f.et,
      f.fp,
      f.owners,
      f.node,
      'alice',
    );
    await f.hj.receive('edge_a', [authority]);
    await f.accounts.applyFromFacade(f.hj, f.bundle.id, authority);
    for (const record of records) {
      assertEquals(await f.hs.apply(f.hj, record, f.bundle.id), true);
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: committed owner fact survives ACK loss and cold reopen without duplicate intent', async () => {
  const f = await fixture();
  try {
    const records = await f.hs.export('alice', f.bundle.id);
    assert(records.length > 0);
    await f.ej.receive('home', records);
    const complete = f.ej.complete.bind(f.ej);
    f.ej.complete = () => Promise.reject(new Error('injected ACK loss'));
    await assertRejects(
      () => f.es.apply(f.ej, records[0]),
      Error,
      'injected ACK loss',
    );
    f.ej.complete = complete;
    assertEquals(
      (await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM device_operations',
      )).length,
      1,
    );
    assertEquals((await f.ej.next('home', records[0]))?.hash, records[0].hash);
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      const pairings = new Pairings(
        await reopened.server(),
        f.node.signer(),
        f.node.publicKey,
        'b'.repeat(64),
        f.node,
      );
      const tenant = await enrolledTenant(
        reopened,
        pairings,
        'logical.test',
        'edge_a',
      );
      const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
      const owner = new DeviceOperations(reopened, tenant, pairings, f.node);
      assertEquals(await owner.apply(journal, records[0]), true);
      assertEquals(await owner.apply(journal, records[0]), false);
      assertEquals(
        (await (await reopened.tenant('logical.test')).query(
          'SELECT * FROM device_operations',
        )).length,
        1,
      );
      assertEquals(await owner.export('alice'), []);
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: unselected accounts are refused before any export intent', async () => {
  const f = await fixture();
  try {
    for (
      const [owner, pairing] of [[f.hs, f.bundle.id], [
        f.es,
        undefined,
      ]] as const
    ) {
      await assertRejects(
        () => owner.export('bob', pairing),
        Error,
        'account not selected',
      );
    }
  } finally {
    await f.close();
  }
});

Deno.test('device link: revocation before or during tenant admission rolls back at both receiving owners', async () => {
  for (const side of ['home', 'edge'] as const) {
    for (const cut of ['before', 'during'] as const) {
      const f = await fixture();
      try {
        if (side === 'home') {
          await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
          const auth = await exportSessionAuthority(
            f.edge,
            f.et,
            f.fp,
            f.owners,
            f.node,
            'alice',
          );
          await f.hj.receive('edge_a', [auth]);
          await f.accounts.applyFromFacade(f.hj, f.bundle.id, auth);
        }
        const store = side === 'home' ? f.home : f.edge;
        const owner = side === 'home' ? f.hs : f.es;
        const journal = side === 'home' ? f.hj : f.ej;
        const peer = side === 'home' ? 'edge_a' : 'home';
        const records = side === 'home'
          ? await f.es.export('alice')
          : await f.hs.export('alice', f.bundle.id);
        await journal.receive(peer, records);
        const paused = pauseImport(store, cut);
        const outcome = owner.apply(
          journal,
          records[0],
          side === 'home' ? f.bundle.id : undefined,
        )
          .then(() => null, (error) => error);
        try {
          await paused.reached;
          const revoked = await f.hp.revoke(f.bundle.id);
          if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
        } finally {
          paused.resume();
          paused.restore();
        }
        assert(await outcome instanceof Error, 'revoked admission must refuse');
        assertEquals(
          await (await store.tenant('logical.test')).query(
            'SELECT * FROM device_operations',
          ),
          [],
          cut,
        );
        assertEquals(
          (await journal.next(peer, records[0]))?.hash,
          records[0].hash,
        );
      } finally {
        await f.close();
      }
    }
  }
});

Deno.test('device link: revocation after tenant admission completes its exact ACK after cold reopen only', async () => {
  for (const side of ['edge', 'home'] as const) {
    const f = await fixture();
    try {
      if (side === 'home') {
        await upsertDevice(f.et, 'alice', 'PHONE', 'outside');
        const auth = await exportSessionAuthority(
          f.edge,
          f.et,
          f.fp,
          f.owners,
          f.node,
          'alice',
        );
        await f.hj.receive('edge_a', [auth]);
        await f.accounts.applyFromFacade(f.hj, f.bundle.id, auth);
        await f.es.export('alice');
        await updateDeviceName(f.et, 'alice', 'PHONE', 'second edge fact');
      } else {
        await f.hs.export('alice', f.bundle.id);
        await updateDeviceName(f.ht, 'alice', 'LAN', 'second home fact');
      }
      const store = side === 'home' ? f.home : f.edge;
      const receiver = side === 'home' ? f.hs : f.es;
      const currentJournal = side === 'home' ? f.hj : f.ej;
      const peer = side === 'home' ? 'edge_a' : 'home';
      const pairing = side === 'home' ? f.bundle.id : undefined;
      const records = side === 'home'
        ? await f.es.export('alice')
        : await f.hs.export('alice', f.bundle.id);
      assert(records.length >= 2);
      await currentJournal.receive(peer, records);
      const paused = pauseImport(store, 'after');
      const complete = currentJournal.complete.bind(currentJournal);
      currentJournal.complete = () =>
        Promise.reject(new Error('injected ACK loss'));
      const outcome = receiver.apply(currentJournal, records[0], pairing).then(
        () => null,
        (error) => error,
      );
      try {
        await paused.reached;
        const revoked = await f.hp.revoke(f.bundle.id);
        if (side === 'edge') await f.fp.retire(revoked, 'a'.repeat(64));
      } finally {
        paused.resume();
        paused.restore();
      }
      const error = await outcome;
      assert(
        error instanceof Error && error.message === 'injected ACK loss',
        'already admitted fact must reach durable completion, not a new live-grant check',
      );
      currentJournal.complete = complete;
      assertEquals(
        (await (await store.tenant('logical.test')).query(
          'SELECT * FROM device_operations',
        )).length,
        1,
      );
      await store.close();
      const reopened = await f.open(side);
      try {
        const pairings = side === 'edge'
          ? new Pairings(
            await reopened.server(),
            f.node.signer(),
            f.node.publicKey,
            'b'.repeat(64),
            f.node,
          )
          : new Pairings(
            await reopened.server(),
            f.ht.signer(),
            f.ht.publicB64,
            'a'.repeat(64),
          );
        const journal = new Journal(await reopened.server(), LINK_SUPPORTED);
        const owner = new DeviceOperations(
          reopened,
          side === 'edge' ? f.et : f.ht,
          pairings,
          side === 'edge' ? f.node : undefined,
        );
        assertEquals(await owner.apply(journal, records[0], pairing), true);
        assertEquals((await journal.heads(peer, 'in', records[0])).applied, {
          sequence: records[0].sequence,
          hash: records[0].hash,
        });
        assertEquals(
          (await (await reopened.tenant('logical.test')).query(
            'SELECT * FROM device_operations',
          )).length,
          1,
        );
        // A retained receipt is not permission to admit a second signed record.
        await assertRejects(
          () => owner.apply(journal, records[1], pairing),
          Error,
        );
      } finally {
        await reopened.close();
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test('device link: current tenant control, selection and live server grant fence every import', async () => {
  for (const fault of ['control', 'selection', 'revoked'] as const) {
    const f = await fixture();
    try {
      const records = await f.hs.export('alice', f.bundle.id);
      assert(records.length > 0);
      await f.ej.receive('home', records);
      const tenant = await f.edge.tenant('logical.test');
      if (fault === 'control') {
        await tenant.tx((conn) =>
          conn.execute('DELETE FROM facade_owner_activation')
        );
      } else if (fault === 'selection') {
        await tenant.tx((conn) =>
          conn.execute(
            'UPDATE account_auth_snapshots SET grant_revision=grant_revision+1',
          )
        );
      } else {await (await f.edge.server()).tx((conn) =>
          conn.execute("UPDATE facade_pairings SET state='revoked'")
        );}
      await assertRejects(() => f.es.apply(f.ej, records[0]), Error);
      assertEquals(await tenant.query('SELECT * FROM device_operations'), []);
      assertEquals(
        (await f.ej.next('home', records[0]))?.hash,
        records[0].hash,
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test('device link: forged signature, source, account, grant and stream never mutate the tenant or advance apply', async () => {
  const variants = [
    'signature',
    'source',
    'localpart',
    'grantRevision',
    'stream',
  ] as const;
  for (const variant of variants) {
    const f = await fixture();
    try {
      const records = await f.hs.export('alice', f.bundle.id);
      assert(records.length > 0, 'device source intent is required');
      const record = structuredClone(records[0]);
      const signed = record.payload as {
        body: Record<string, unknown>;
        signature: string;
      };
      if (variant === 'signature') signed.signature = 'A'.repeat(86);
      else if (variant === 'stream') {
        record.stream = 'devices:@bob:logical.test';
      } else {
        signed.body[variant] = variant === 'source'
          ? 'edge_a'
          : variant === 'localpart'
          ? 'bob'
          : Number(signed.body.grantRevision) + 1;
        signed.signature = await f.ht.signer().sign(canonicalJson(signed.body));
      }
      const { hash: _hash, ...body } = record;
      record.hash = recordHash(body);
      await f.ej.receive('home', [record]);
      await assertRejects(() => f.es.apply(f.ej, record), Error);
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM device_operations',
        ),
        [],
      );
      assertEquals((await f.ej.next('home', record))?.hash, record.hash);
    } finally {
      await f.close();
    }
  }
});
