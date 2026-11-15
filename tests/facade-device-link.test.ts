import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
  exportSessionAuthority,
} from '#engine/facade/accounts.ts';
import { DeviceOperations } from '#engine/facade/devices.ts';
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
    const apply = f.ej.apply.bind(f.ej);
    f.ej.apply = () => Promise.reject(new Error('injected ACK loss'));
    await assertRejects(
      () => f.es.apply(f.ej, records[0]),
      Error,
      'injected ACK loss',
    );
    f.ej.apply = apply;
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
