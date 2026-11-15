import { assertEquals, assertRejects } from '@std/assert';
import { createHash } from 'node:crypto';
import { canonicalJson } from '#engine/canonical.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
} from '#engine/facade/accounts.ts';
import {
  type DomainBootstrap,
  type DomainOperation,
  DomainOperations,
} from '#engine/facade/domain.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { bindRole } from '#engine/facade/role.ts';
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
import {
  captureAccountDataOperations,
  getAccountData,
  putAccountData,
} from '#engine/tenant/accountdata.ts';
import {
  captureProfileOperations,
  setProfileField,
} from '#engine/tenant/profiles.ts';
import { capturePushRuleOperations } from '#engine/tenant/pushrules.ts';
import {
  receiptOperations,
  recordReceiptOperation,
} from '#engine/server/receipt-operations.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-domain-link-' });
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
  const auth = await exportAccountAuth(home, ht, hp, bundle.id, 'alice', false);
  await ej.receive('home', [auth]);
  await new AccountSnapshots(edge, et, fp, owners).apply(ej, auth);
  const hs = new DomainOperations(home, ht, hp),
    es = new DomainOperations(edge, et, fp, node);
  return {
    dir,
    open,
    home,
    edge,
    ht,
    et,
    hp,
    fp,
    hj,
    ej,
    owners,
    node,
    bundle,
    hs,
    es,
    capture: () =>
      (home.tenant('logical.test')).then((db) =>
        db.tx(async (conn) => {
          await captureAccountDataOperations(conn, 'alice');
          await captureProfileOperations(conn, 'alice');
          await capturePushRuleOperations(conn, 'alice', 'logical.test');
        })
      ),
    async toEdge(records: LinkRecord[]) {
      for (const record of records) {
        await ej.receive('home', [record]);
        await es.apply(ej, record);
      }
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('domain link: semantic operations have an explicitly negotiated reader', () => {
  assertEquals(
    LINK_SUPPORTED.some((item) =>
      item.type === 'domain-operation' && item.version === 1
    ),
    true,
  );
});

Deno.test('domain link: signed owner operations reconcile both directions without export echoes or duplicate news', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'protected',
      fraction: 0.25,
    });
    await putAccountData(f.ht, 'alice', '!r:logical.test', 'm.tag', {
      tags: { work: { order: 0.5 } },
    });
    await setProfileField(f.ht, 'alice', 'displayname', 'Home Alice');
    await f.capture();
    const sent = await f.hs.export('alice', f.bundle.id);
    assertEquals(
      [
        ...new Set(
          sent.map((record) =>
            (record.payload as { body: { operation: { kind: string } } }).body
              .operation.kind
          ),
        ),
      ].sort(),
      ['account-data', 'profile', 'push-rules', 'tags'],
    );
    await f.toEdge(sent);
    assertEquals(
      await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'protected', fraction: 0.25 },
    );
    assertEquals(
      await f.et.tx((tx) => tx.profiles.get('alice')).then((p) =>
        p?.displayname
      ),
      'Home Alice',
    );
    assertEquals(await f.es.export('alice'), []);
    assertEquals(await f.hs.export('alice', f.bundle.id), sent);
    const news = await f.et.tx((tx) => tx.streams.heads());
    // Simulate the crash window AFTER the semantic owner committed but BEFORE
    // the server journal's applied receipt. Replay must not stamp new news.
    await (await f.edge.server()).execute(
      "UPDATE facade_streams SET applied=0,applied_hash='' WHERE direction='in' AND stream=?",
      [sent[0].stream],
    );
    await (await f.edge.server()).execute(
      "UPDATE facade_records SET result_json=NULL WHERE direction='in' AND stream=?",
      [sent[0].stream],
    );
    for (const record of sent) {
      assertEquals(await f.es.apply(f.ej, record), true);
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), news);
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'edge-winner',
    });
    await setProfileField(f.et, 'alice', 'displayname', 'Edge Alice');
    const reverse = await f.es.export('alice');
    assertEquals(reverse.length, 2);
    for (const record of reverse) {
      await f.hj.receive('edge_a', [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(
      await getAccountData(f.ht, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'edge-winner' },
    );
    assertEquals(
      await f.ht.tx((tx) => tx.profiles.get('alice')).then((p) =>
        p?.displayname
      ),
      'Edge Alice',
    );
    assertEquals(await f.hs.export('alice', f.bundle.id), sent);
    const old = new Journal(await f.edge.server(), LINK_CAPABILITIES);
    await assertRejects(
      () => old.receive('home', [sent[0]]),
      LinkError,
      'unsupported record type',
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain link: source admission is durable even before receiver receipt evidence arrives', async () => {
  const f = await fixture();
  try {
    await (await f.home.server()).tx((conn) =>
      recordReceiptOperation(conn, {
        roomId: '!r:logical.test',
        userId: '@alice:logical.test',
        receiptType: 'm.read.private',
        threadId: null,
        eventIds: ['$target'],
        ts: 1,
        admission: { membershipEvent: '$original-join' },
      })
    );
    const sent = await f.hs.export('alice', f.bundle.id);
    assertEquals(sent.length, 1);
    await f.toEdge(sent);
    const rows = await (await f.edge.server()).tx((conn) =>
      receiptOperations(conn, '@alice:logical.test')
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].kind, 'receipt');
    assertEquals(
      await (await f.edge.server()).query(
        "SELECT applied FROM domain_operations WHERE kind='receipt'",
      ),
      [{ applied: 0 }],
    );
    assertEquals((await f.ej.heads('home', 'in', sent[0])).applied.sequence, 1);
    assertEquals(await f.es.export('alice'), []);
    await f.edge.close();
    const reopened = await f.open('edge');
    try {
      assertEquals(
        await (await reopened.server()).tx((conn) =>
          receiptOperations(conn, '@alice:logical.test')
        ),
        rows,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.close();
  }
});

Deno.test('domain link: rejects forged signatures, source, grant, account and future control before ACK', async (t) => {
  for (
    const fault of [
      'signature',
      'source',
      'grant',
      'account',
      'future-control',
      'revoked',
    ]
  ) {
    await t.step(fault, async () => {
      const f = await fixture();
      try {
        await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
          ciphertext: 'protected',
        });
        const [original] = await f.hs.export('alice', f.bundle.id);
        const record = structuredClone(original);
        const payload = record.payload as {
          body: Record<string, unknown> & {
            operation: { operationId: string; source: string };
          };
          signature: string;
        };
        if (fault === 'source') {
          payload.body.source = payload.body.operation.source = 'edge_a';
        }
        if (fault === 'grant') payload.body.grantRevision = 99;
        if (fault === 'account') payload.body.localpart = 'bob';
        if (fault === 'future-control') payload.body.ownerRevision = 99;
        if (fault !== 'signature') {
          payload.signature = await f.ht.signer().sign(
            canonicalJson(payload.body),
          );
        } else payload.signature = 'A'.repeat(86);
        record.operationId = 'domain:' +
          createHash('sha256').update(
            canonicalJson([
              payload.body.pairing,
              payload.body.grantRevision,
              payload.body.ownerRevision,
              payload.body.operation.operationId,
            ]),
          ).digest('hex');
        record.hash = recordHash({
          source: record.source,
          incarnation: record.incarnation,
          stream: record.stream,
          sequence: record.sequence,
          type: record.type,
          version: record.version,
          operationId: record.operationId,
          previous: record.previous,
          payload: record.payload,
        });
        await f.ej.receive('home', [record]);
        if (fault === 'revoked') {
          await (await f.edge.server()).execute(
            "UPDATE facade_pairings SET state='revoked'",
          );
        }
        await assertRejects(() => f.es.apply(f.ej, record), LinkError);
        assertEquals(
          (await f.ej.heads('home', 'in', record)).applied.sequence,
          0,
        );
        assertEquals(
          await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
          null,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('domain link: selected account scope is required for export and reverse application', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'bob', '', 'm.secret_storage.key', {
      ciphertext: 'bob-only',
    });
    await assertRejects(
      () => f.hs.export('bob', f.bundle.id),
      LinkError,
      'not selected',
    );
    await f.toEdge(await f.hs.export('alice', f.bundle.id));
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'edge-only',
    });
    const [record] = await f.es.export('alice');
    await f.hj.receive('edge_a', [record]);
    await (await f.home.server()).execute(
      'DELETE FROM facade_exports WHERE scope=?',
      ['auth:@alice:logical.test'],
    );
    await assertRejects(
      () => f.hs.apply(f.hj, record, f.bundle.id),
      LinkError,
      'not selected',
    );
    assertEquals(
      (await f.hj.heads('edge_a', 'in', record)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain bootstrap: explicit complete owner cut enables scope only after all signed operations apply', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'complete-bootstrap',
    });
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    const marker = records.at(-1)!;
    const view = (marker.payload as { body: DomainBootstrap }).body;
    assertEquals(view.kind, 'domain-bootstrap');
    assertEquals(view.tenant.length >= 3, true);
    assertEquals(view.receipts, []);
    await f.toEdge(records.slice(0, -1));
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [],
    );
    await f.toEdge([marker]);
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready,source_cut FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [{ ready: 1, source_cut: marker.sequence }],
    );
    assertEquals(
      await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'complete-bootstrap' },
    );
    assertEquals(await f.hs.bootstrap('alice', f.bundle.id), records);
    assertEquals(await f.es.export('alice'), []);
    await assertRejects(
      () => f.es.bootstrap('alice', f.bundle.id),
      LinkError,
      'only home',
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain bootstrap: missing owner facts prevent readiness and ACK until authentic replay restores them', async () => {
  const f = await fixture();
  try {
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'retained-fact',
    });
    const records = await f.hs.bootstrap('alice', f.bundle.id),
      marker = records.at(-1)!;
    await f.toEdge(records.slice(0, -1));
    const operation = (records.find((record) =>
      (record.payload as { body: DomainOperation }).body.operation?.kind ===
        'account-data'
    )!.payload as { body: DomainOperation }).body.operation;
    const db = await f.edge.tenant('logical.test');
    await db.execute('DELETE FROM domain_operations WHERE operation_id=?', [
      operation.operationId,
    ]);
    await f.ej.receive('home', [marker]);
    await assertRejects(
      () =>
        f.es.apply(f.ej, marker),
      LinkError,
      'awaits retained facts',
    );
    assertEquals(
      (await f.ej.heads('home', 'in', marker)).applied.sequence,
      marker.sequence - 1,
    );
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [],
    );
    const before = await f.et.tx((tx) => tx.streams.heads());
    await f.et.tx((tx) => tx.accountData.import(operation));
    assertEquals(await f.es.apply(f.ej, marker), true);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    assertEquals(
      await (await f.edge.server()).query(
        'SELECT ready FROM facade_scopes WHERE scope=?',
        [marker.stream],
      ),
      [{ ready: 1 }],
    );
  } finally {
    await f.close();
  }
});
