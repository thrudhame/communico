import { assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { registerUser, verifyUserPassword } from '#engine/tenant/users.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-account-auth-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  const home = await open('home'), edge = await open('edge');
  const ht = await openTenant(home, 'logical.test', { create: true });
  await registerUser(ht, {
    localpart: 'alice',
    password: 'pw',
    accessToken: null,
  });
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
  const journal = new Journal(await edge.server(), LINK_SUPPORTED);
  const owners = new OwnerControls(
    await edge.server(),
    await edge.tenant('logical.test'),
    fp,
    node,
  );
  const owner = await exportOwnerControl(home, ht, hp, bundle.id);
  await journal.receive('home', [owner]);
  await owners.apply(journal, owner);
  const receiver = new AccountSnapshots(edge, et, fp, owners);
  const emit = (credentials = true) =>
    exportAccountAuth(home, ht, hp, bundle.id, 'alice', credentials);
  return {
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    bundle,
    journal,
    receiver,
    emit,
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('signed account auth crosses the negotiated journal and applies before its durable ACK without secrets in results', async () => {
  const f = await fixture();
  try {
    const record = await f.emit();
    const legacy = new Journal(await f.edge.server(), LINK_CAPABILITIES);
    await assertRejects(
      () => legacy.receive('home', [record]),
      LinkError,
      'unsupported record type',
    );
    await f.journal.receive('home', [record]);
    assertEquals(await f.receiver.apply(f.journal, record), true);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), true);
    assertEquals(
      (await f.journal.heads('home', 'in', record)).applied.sequence,
      record.sequence,
    );
    const rows = await (await f.edge.server()).query(
      'SELECT result_json FROM facade_records WHERE stream=?',
      [record.stream],
    );
    assertEquals(canonicalJson(rows).includes('$argon2'), false);
    assertEquals(canonicalJson(record).includes('privkey'), false);
    const disabled = await f.emit(false);
    await f.journal.receive('home', [disabled]);
    await f.receiver.apply(f.journal, disabled);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      await (await f.edge.tenant('logical.test')).query(
        'SELECT * FROM access_tokens',
      ),
      [],
    );
  } finally {
    await f.close();
  }
});

Deno.test('a forged account auth value never installs or advances its applied journal cut', async () => {
  const f = await fixture();
  try {
    const valid = await f.emit();
    const payload = structuredClone(valid.payload) as {
      signed: { signature: string; body: { phc: string | null } };
    };
    payload.signed.body.phc = null;
    const forged = await new Journal(await f.home.server(), LINK_SUPPORTED)
      .append('edge_a', {
        source: 'home',
        incarnation: f.bundle.id,
        stream: valid.stream + '-forged',
        type: 'account-auth',
        version: 1,
        operationId: 'forged-auth',
        payload,
      });
    await f.journal.receive('home', [forged]);
    await assertRejects(
      () => f.receiver.apply(f.journal, forged),
      LinkError,
      'invalid home account auth signature',
    );
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    assertEquals(
      (await f.journal.heads('home', 'in', forged)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});
