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
import { JournalReconciler } from '#engine/facade/worker.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
} from '#engine/facade/protocol.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { requireAccountAuth } from '#engine/tenant/account-auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
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
    node,
    owners,
    bundle,
    journal,
    receiver,
    emit,
    async nextOwner(install = true) {
      const body = { ...(await owners.ready()), revision: 2 };
      const signed = {
        body,
        signature: await ht.signer().sign(canonicalJson(body)),
      };
      const record = await new Journal(await home.server(), LINK_SUPPORTED)
        .append('edge_a', {
          source: 'home',
          incarnation: bundle.id,
          stream: 'owner-control',
          type: 'owner-control',
          version: 1,
          operationId: 'owner-control-revision-2',
          payload: signed,
        });
      // Simulate the home control owner's publication of its next revision.
      await (await home.server()).execute(
        'UPDATE facade_owner_activation SET revision=2 WHERE pairing=?',
        [bundle.id],
      );
      await journal.receive('home', [record]);
      if (install) await owners.apply(journal, record);
      return record;
    },
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

Deno.test('reconciliation retries the same durable auth export after a legacy reader upgrade', async () => {
  const f = await fixture();
  try {
    const record = await f.emit();
    const source = new Journal(await f.home.server(), LINK_SUPPORTED);
    let reader = new Journal(await f.edge.server(), LINK_CAPABILITIES);
    const errors: unknown[] = [];
    const sent: unknown[] = [];
    const limits = { maxBytes: 1000000, maxItems: 100 };
    const reconciler = new JournalReconciler({
      journal: source,
      limits,
      apply: () => Promise.resolve(false),
      failed: (error) => errors.push(error),
      client: {
        peer: {
          server: 'logical.test',
          node: 'edge_a',
          incarnation: f.node.incarnation,
          pairing: f.bundle.id,
          revision: 1,
        },
        hello: async () => ({
          revision: 1,
          scopes: [],
          incoming: await reader.streams('home', 'in'),
          outgoing: [],
          exportAcks: [],
        }),
        push: async (stream, records, after) => {
          if (stream.stream === record.stream) sent.push(...records);
          await reader.receive('home', records);
          if (stream.stream === record.stream) {
            while (await f.receiver.apply(reader, stream)) { /* Drain. */ }
          }
          return await reader.acknowledgement('home', stream, after, limits);
        },
        pull: () => Promise.reject(new Error('no facade source')),
        ack: () => Promise.reject(new Error('no facade source')),
        notices: async function* () {},
      },
    });
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(errors.length > 0, true);
    assertEquals(
      (await source.acknowledged('edge_a', record)).received.sequence,
      0,
    );
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
    reader = f.journal;
    errors.length = 0;
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(errors, []);
    assertEquals(sent, [record, record]);
    assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), true);
    assertEquals(
      (await source.acknowledged('edge_a', record)).applied.sequence,
      record.sequence,
    );
    assertEquals(
      (await source.heads('edge_a', 'out', record)).received.sequence,
      record.sequence,
    );
  } finally {
    await f.close();
  }
});

for (const timing of ['queued', 'install', 'completion'] as const) {
  Deno.test(`obsolete auth advances only its source cut when ownership changes at ${timing}`, async () => {
    const f = await fixture();
    try {
      const old = await f.emit();
      await f.journal.receive('home', [old]);
      let receiver = f.receiver;
      if (timing === 'queued') await f.nextOwner();
      if (timing === 'install') {
        receiver = new AccountSnapshots(f.edge, f.et, f.fp, {
          ready: async () => {
            const prior = await f.owners.ready();
            await f.nextOwner();
            return prior;
          },
        });
      }
      if (timing === 'completion') {
        const db = await f.edge.tenant('logical.test');
        receiver = new AccountSnapshots(
          new Proxy(f.edge, {
            get: (store, key) => {
              if (key === 'tenant') {
                return () =>
                  Promise.resolve({
                    ...db,
                    tx: async <T>(callback: Parameters<typeof db.tx<T>>[0]) => {
                      const result = await db.tx(callback);
                      await f.nextOwner();
                      return result;
                    },
                  });
              }
              const value = Reflect.get(store, key);
              return typeof value === 'function' ? value.bind(store) : value;
            },
          }),
          f.et,
          f.fp,
          f.owners,
        );
      }
      assertEquals(await receiver.apply(f.journal, old), true);
      assertEquals(
        (await f.journal.heads('home', 'in', old)).applied.sequence,
        old.sequence,
      );
      const [scope] = await (await f.edge.server()).query(
        'SELECT source_cut,ready,pending_hash FROM facade_scopes WHERE scope=?',
        [old.stream],
      );
      const cut =
        (old.payload as { signed: { body: { sourceCut: number } } }).signed.body
          .sourceCut;
      assertEquals(scope, { source_cut: cut, ready: 0, pending_hash: null });
      if (timing !== 'completion') {
        assertEquals(
          await (await f.edge.tenant('logical.test')).query(
            'SELECT * FROM account_auth_snapshots',
          ),
          [],
        );
        assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), false);
      }
      await assertRejects(
        async () =>
          (await f.edge.tenant('logical.test')).tx((conn) =>
            requireAccountAuth(
              conn,
              'alice',
              { pairing: f.bundle.id, grantRevision: 1, ownerRevision: 2 },
              { allowstaleauth: true, authmaxstalehours: 0 },
              true,
              true,
            )
          ),
        MatrixError,
        'authentication snapshot unavailable',
      );
      const next = await f.emit();
      await f.journal.receive('home', [next]);
      assertEquals(await f.receiver.apply(f.journal, next), true);
      assertEquals(await verifyUserPassword(f.et, 'alice', 'pw'), true);
      assertEquals(
        (await f.journal.heads('home', 'in', next)).applied.sequence,
        next.sequence,
      );
      assertEquals(
        (await (await f.edge.server()).query(
          'SELECT ready FROM facade_scopes WHERE scope=?',
          [next.stream],
        ))[0].ready,
        1,
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test('future auth waits for its control and a forged obsolete auth never consumes the source cut', async () => {
  const f = await fixture();
  try {
    const owner = await f.nextOwner(false);
    const future = await f.emit();
    await f.journal.receive('home', [future]);
    await assertRejects(() => f.receiver.apply(f.journal, future), LinkError);
    assertEquals(
      (await f.journal.heads('home', 'in', future)).applied.sequence,
      0,
    );
    await f.owners.apply(f.journal, owner);
    assertEquals(await f.receiver.apply(f.journal, future), true);
    const payload = structuredClone(future.payload) as {
      after: number;
      signed: { body: { ownerRevision: number } };
    };
    payload.after = payload.after + 1;
    payload.signed.body.ownerRevision = 1;
    const forged = await new Journal(await f.home.server(), LINK_SUPPORTED)
      .append('edge_a', {
        source: 'home',
        incarnation: f.bundle.id,
        stream: future.stream,
        type: 'account-auth',
        version: 1,
        operationId: 'forged-obsolete',
        payload,
      });
    await f.journal.receive('home', [forged]);
    await assertRejects(
      () => f.receiver.apply(f.journal, forged),
      LinkError,
      'invalid home account auth signature',
    );
    assertEquals(
      (await f.journal.heads('home', 'in', future)).applied.sequence,
      future.sequence,
    );
  } finally {
    await f.close();
  }
});
