import { assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
  exportSessionAuthority,
} from '#engine/facade/accounts.ts';
import { DeviceOperations } from '#engine/facade/devices.ts';
import { DomainOperations } from '#engine/facade/domain.ts';
import { ToDeviceOperations } from '#engine/facade/todevice.ts';
import { config } from '#engine/config.ts';
import type { DomainBinding } from '#engine/facade/domain-control.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
  type LinkRecord,
  recordHash,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { getAccountData, putAccountData } from '#engine/tenant/accountdata.ts';
import { upsertDevice } from '#engine/tenant/devices.ts';
import { publicDeviceValues } from '#engine/tenant/device-operations.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';

// Retain a genuine home-authenticated selection, but deliberately do not apply
// it. No worker timing or forged snapshot stands in for this dependency cut.
async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-selection-' });
  const open = (side: string) =>
    openStore({
      dir: dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home');
  let edge = await open('edge');
  const ht = await openTenant(home, 'logical.test', { create: true });
  await ht.tx((tx) => tx.users.insert('alice', 'Alice'));
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
  const pairing = async () =>
    new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      'b'.repeat(64),
      node,
    );
  let fp = await pairing();
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
  const consumers = async () => {
    const et = await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
    const journal = new Journal(await edge.server(), LINK_SUPPORTED);
    const owners = new OwnerControls(
      await edge.server(),
      await edge.tenant('logical.test'),
      fp,
      node,
    );
    return {
      et,
      journal,
      owners,
      auth: new AccountSnapshots(edge, et, fp, owners),
      domain: new DomainOperations(edge, et, fp, node),
      devices: new DeviceOperations(edge, et, fp, node),
      todevice: new ToDeviceOperations(edge, et, fp, node),
      authority: () =>
        exportSessionAuthority(edge, et, fp, owners, node, 'alice'),
    };
  };
  let consumer = await consumers();
  const control = await exportOwnerControl(home, ht, hp, bundle.id);
  await consumer.journal.receive('home', [control]);
  await consumer.owners.apply(consumer.journal, control);
  await upsertDevice(ht, 'alice', 'LAN', 'home device');
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await consumer.journal.receive('home', [auth]);
  await putAccountData(ht, 'alice', '', 'm.direct', { held: 'selection' });
  const domains = new DomainOperations(home, ht, hp);
  const devices = new DeviceOperations(home, ht, hp);
  const todevice = new ToDeviceOperations(home, ht, hp);
  return {
    home,
    ht,
    bundle,
    auth,
    get edge() {
      return edge;
    },
    get consumer() {
      return consumer;
    },
    domain: () => domains.export('alice', bundle.id),
    bootstrap: () => domains.bootstrap('alice', bundle.id),
    devices: () => devices.export('alice', bundle.id),
    async todevice() {
      const device = await deviceIdentity(ht, 'alice', 'LAN');
      await ht.tx((tx) =>
        tx.toDevice.send(
          device,
          ht.serverName,
          'm.room_key_request',
          'held-selection',
          'held-body',
          [{ user: '@alice:logical.test', id: 'LAN', content: { held: true } }],
          config().e2ee,
          { enabled: true, maxBytes: 1048576 },
        )
      );
      return await todevice.export('alice', bundle.id);
    },
    homeAuthority: new AccountSnapshots(home, ht, hp),
    homeJournal: new Journal(await home.server(), LINK_SUPPORTED),
    async reopen() {
      await edge.close();
      edge = await open('edge');
      fp = await pairing();
      consumer = await consumers();
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

async function unavailable(fn: () => Promise<unknown>) {
  const error = await assertRejects(fn, LinkError);
  assertEquals(error.code, 'LINK_UNAVAILABLE');
  assertEquals(error.status, 503);
}

for (const kind of ['domain', 'bootstrap', 'devices', 'authority'] as const) {
  Deno.test(`account selection: held home export blocks ${kind} until selected`, async () => {
    const f = await fixture();
    try {
      await f.consumer.auth.apply(f.consumer.journal, f.auth);
      const authority = kind === 'authority'
        ? await f.consumer.authority()
        : null;
      if (authority) await f.homeJournal.receive('edge_a', [authority]);
      const server = await f.home.server();
      const scope = 'auth:@alice:logical.test';
      const [selection] = await server.query(
        'SELECT * FROM facade_exports WHERE incarnation=? AND scope=?',
        [f.bundle.id, scope],
      );
      await server.execute(
        'DELETE FROM facade_exports WHERE incarnation=? AND scope=?',
        [f.bundle.id, scope],
      );
      const before = await server.query(
        'SELECT * FROM facade_streams ORDER BY stream',
      );
      const attempt = () =>
        authority
          ? f.homeAuthority.applyFromFacade(
            f.homeJournal,
            f.bundle.id,
            authority,
          )
          : f[kind as 'domain' | 'bootstrap' | 'devices']();
      await unavailable(attempt);
      await unavailable(attempt);
      await server.execute(
        "UPDATE facade_pairings SET state='revoked' WHERE id=? AND side='home'",
        [f.bundle.id],
      );
      const wrongGrant = await assertRejects(attempt, LinkError);
      assertEquals(wrongGrant.status, 403);
      await server.execute(
        "UPDATE facade_pairings SET state='paired' WHERE id=? AND side='home'",
        [f.bundle.id],
      );
      assertEquals(
        await server.query('SELECT * FROM facade_streams ORDER BY stream'),
        before,
      );
      await server.execute(
        'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?)',
        [
          selection.peer,
          selection.incarnation,
          selection.scope,
          selection.source_cut,
        ],
      );
      const result = await attempt();
      if (authority) {
        assertEquals(result, true);
        assertEquals(
          (await f.homeJournal.heads('edge_a', 'in', authority)).applied
            .sequence,
          authority.sequence,
        );
      } else {
        assertEquals(Array.isArray(result), true);
        assertEquals((result as LinkRecord[]).length > 0, true);
        const owner = kind === 'devices'
          ? f.consumer.devices
          : f.consumer.domain;
        for (const record of result as LinkRecord[]) {
          await f.consumer.journal.receive('home', [record]);
          await owner.apply(f.consumer.journal, record);
        }
        if (kind === 'devices') {
          assertEquals(
            await (await f.edge.tenant('logical.test')).tx(async (conn) =>
              (await publicDeviceValues(conn, 'alice')).map((device) =>
                device.deviceId
              )
            ),
            ['LAN'],
          );
        } else {
          assertEquals(
            await getAccountData(f.consumer.et, 'alice', '', 'm.direct'),
            { held: 'selection' },
          );
        }
      }
    } finally {
      await f.close();
    }
  });
}

Deno.test('account selection: tenant domain transaction shares the readiness fence', async () => {
  const f = await fixture();
  try {
    const [record] = await f.domain();
    const { body } = record.payload as { body: DomainBinding };
    const authorize = () =>
      f.consumer.et.tx((tx) =>
        tx.domains.authorize(body, {
          pairing: f.bundle.id,
          revision: body.grantRevision,
        })
      );
    await unavailable(authorize);
    await f.consumer.auth.apply(f.consumer.journal, f.auth);
    await authorize();
    await (await f.edge.tenant('logical.test')).execute(
      'UPDATE account_auth_snapshots SET grant_revision=99',
    );
    const error = await assertRejects(authorize, LinkError);
    assertEquals(error.code, 'LINK_IDENTITY_MISMATCH');
  } finally {
    await f.close();
  }
});

for (
  const kind of [
    'domain',
    'bootstrap',
    'devices',
    'todevice',
    'todevice-cold',
    'authority',
    'cold',
  ] as const
) {
  Deno.test(`account selection: held auth blocks ${kind} until applied`, async () => {
    const f = await fixture();
    try {
      const records = kind === 'authority' ? [] : await f[
        kind === 'cold'
          ? 'bootstrap'
          : kind === 'todevice-cold'
          ? 'todevice'
          : kind
      ]();
      for (const record of records) {
        await f.consumer.journal.receive('home', [record]);
      }
      if (kind === 'cold' || kind === 'todevice-cold') await f.reopen();
      const c = f.consumer;
      const owner = kind === 'todevice' || kind === 'todevice-cold'
        ? c.todevice
        : kind === 'devices'
        ? c.devices
        : c.domain;
      const before = await (await f.edge.server()).query(
        'SELECT * FROM facade_streams ORDER BY stream',
      );
      const attempt = async () => {
        if (kind === 'authority') return await c.authority();
        const record = records[0];
        return await owner.apply(
          c.journal,
          record,
        );
      };
      await unavailable(attempt);
      await unavailable(attempt);
      if (kind !== 'authority') {
        await unavailable(() => owner.export('alice'));
      }
      assertEquals(
        await (await f.edge.server()).query(
          'SELECT * FROM facade_streams ORDER BY stream',
        ),
        before,
      );
      assertEquals(
        await (await f.edge.tenant('logical.test')).query(
          'SELECT * FROM account_auth_snapshots',
        ),
        [],
      );
      if (kind === 'todevice' || kind === 'todevice-cold') {
        assertEquals(
          await (await f.edge.tenant('logical.test')).query(
            'SELECT operation_id FROM to_device_operations',
          ),
          [],
        );
      }
      assertEquals(await c.journal.next('home', f.auth), f.auth);
      await c.auth.apply(c.journal, f.auth);
      if (kind === 'authority') {
        const record = await c.authority();
        assertEquals(record.stream, 'authority:@alice:logical.test');
        assertEquals(record.sequence, 1);
      } else {
        for (const record of records) {
          assertEquals(
            await owner.apply(
              c.journal,
              record,
            ),
            true,
          );
          assertEquals(
            (await c.journal.heads('home', 'in', record)).applied.sequence,
            record.sequence,
          );
        }
        if (kind === 'devices') {
          assertEquals(
            await (await f.edge.tenant('logical.test')).tx(async (conn) =>
              (await publicDeviceValues(conn, 'alice')).map((
                device,
              ) => [device.deviceId, device.value?.displayName])
            ),
            [['LAN', 'home device']],
          );
        } else if (kind === 'todevice' || kind === 'todevice-cold') {
          assertEquals(
            await (await f.edge.tenant('logical.test')).query(
              "SELECT operation_id FROM to_device_operations WHERE source='home' ORDER BY operation_id",
            ),
            records.map((record) => {
              const signed = record.payload as {
                body: { operation: { operationId: string } };
              };
              return { operation_id: signed.body.operation.operationId };
            }).sort((a, b) => a.operation_id.localeCompare(b.operation_id)),
          );
        } else {
          assertEquals(await getAccountData(c.et, 'alice', '', 'm.direct'), {
            held: 'selection',
          });
        }
      }
    } finally {
      await f.close();
    }
  });
}

for (const kind of ['domain', 'devices', 'todevice', 'authority'] as const) {
  Deno.test(`account selection: conflicting snapshot stays hard for ${kind}`, async (t) => {
    for (const fault of ['pairing', 'revision']) {
      await t.step(fault, async () => {
        const f = await fixture();
        try {
          const c = f.consumer;
          await c.auth.apply(c.journal, f.auth);
          const records = kind === 'authority' ? [] : await f[kind]();
          for (const record of records) {
            await c.journal.receive('home', [record]);
          }
          await (await f.edge.tenant('logical.test')).execute(
            fault === 'pairing'
              ? "UPDATE account_auth_snapshots SET pairing='other'"
              : 'UPDATE account_auth_snapshots SET grant_revision=99',
          );
          const before = await (await f.edge.server()).query(
            'SELECT * FROM facade_streams ORDER BY stream',
          );
          const error = await assertRejects(
            () =>
              kind === 'authority' ? c.authority() : c[kind].apply(
                c.journal,
                records[0],
              ),
            LinkError,
          );
          assertEquals(error.code, 'LINK_IDENTITY_MISMATCH');
          assertEquals(error.status, 403);
          assertEquals(
            await (await f.edge.server()).query(
              'SELECT * FROM facade_streams ORDER BY stream',
            ),
            before,
          );
        } finally {
          await f.close();
        }
      });
    }
  });
}

for (const kind of ['domain', 'devices', 'todevice'] as const) {
  Deno.test(`account selection: missing auth cannot soften invalid ${kind} authority`, async (t) => {
    for (const fault of ['signature', 'account', 'pairing', 'grant']) {
      await t.step(fault, async () => {
        const f = await fixture();
        try {
          const [record] = await f[kind]();
          const signed = record.payload as {
            body: Record<string, unknown>;
            signature: string;
          };
          if (fault === 'account') signed.body.localpart = 'bob';
          if (fault === 'pairing') signed.body.pairing = 'other';
          if (fault === 'grant') signed.body.grantRevision = 99;
          signed.signature = fault === 'signature'
            ? 'A'.repeat(86)
            : await f.ht.signer().sign(canonicalJson(signed.body));
          const { hash: _, ...body } = record;
          const forged: LinkRecord = { ...body, hash: recordHash(body) };
          const c = f.consumer;
          await c.journal.receive('home', [forged]);
          const error = await assertRejects(
            () => c[kind].apply(c.journal, forged),
            LinkError,
          );
          assertEquals(error.code, 'LINK_IDENTITY_MISMATCH');
          assertEquals(
            (await c.journal.heads('home', 'in', forged)).applied.sequence,
            0,
          );
        } finally {
          await f.close();
        }
      });
    }
  });
}
