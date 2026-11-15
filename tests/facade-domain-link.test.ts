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
import { AuthLinkHealth, FacadeAuth } from '#engine/facade/auth.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { setAvatarUrl, setDisplayName } from '#engine/tenant/users.ts';
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
  updateRoomTag,
} from '#engine/tenant/accountdata.ts';
import {
  captureProfileOperations,
  getPublicProfile,
  setProfileField,
} from '#engine/tenant/profiles.ts';
import {
  capturePushRuleOperations,
  putRule,
  rulesetFor,
  setRuleEnabled,
} from '#engine/tenant/pushrules.ts';
import {
  importRegisterOperation,
  writeRegister,
} from '#engine/facade/registers.ts';
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

Deno.test('domain link: user-facing register owners require complete domain bootstrap, independently of password availability', async () => {
  const f = await fixture();
  try {
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      new FacadeAuth(
        await f.edge.server(),
        f.fp,
        f.node,
        new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
        {
          replicatecredentials: false,
          allowstaleauth: false,
          authmaxstalehours: 1,
        },
      ),
    );
    const intents = [
      () => getAccountData(tenant, 'alice', '', 'm.direct'),
      () => getPublicProfile(tenant, 'alice'),
      () => rulesetFor(tenant, 'alice'),
      () =>
        putAccountData(tenant, 'alice', '', 'm.direct', { protected: true }),
      () => updateRoomTag(tenant, 'alice', '!r:logical.test', 'work', {}),
      () => setProfileField(tenant, 'alice', 'org.example.field', 'value'),
      () => setDisplayName(tenant, 'alice', 'guarded legacy name'),
      () => setAvatarUrl(tenant, 'alice', 'mxc://logical.test/guarded'),
      () => setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true),
    ];
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const intent of intents) {
      await assertRejects(intent, MatrixError, 'domain snapshot unavailable');
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    assertEquals(await f.et.tx((tx) => tx.accountData.operations('alice')), []);
    assertEquals(await f.et.tx((tx) => tx.profiles.operations('alice')), []);
    assertEquals(await f.et.tx((tx) => tx.pushRules.operations('alice')), []);

    const bootstrap = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(bootstrap);
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), null);
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.displayname,
      'Alice',
    );
    assertEquals(
      await rulesetFor(tenant, 'alice'),
      await rulesetFor(f.ht, 'alice'),
    );
    await putAccountData(tenant, 'alice', '', 'm.direct', {
      after: 'complete',
    });
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), {
      after: 'complete',
    });
    await updateRoomTag(tenant, 'alice', '!r:logical.test', 'work', {
      order: 0.5,
    });
    assertEquals(
      await getAccountData(tenant, 'alice', '!r:logical.test', 'm.tag'),
      { tags: { work: { order: 0.5 } } },
    );
    await setProfileField(tenant, 'alice', 'org.example.field', 'value');
    assertEquals(
      (await getPublicProfile(tenant, 'alice'))?.['org.example.field'],
      'value',
    );
    await setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true);
    assertEquals((await rulesetFor(tenant, 'alice')).override[0].enabled, true);

    await putAccountData(f.ht, 'alice', '', 'm.direct', { suffix: true });
    const cut = Math.max(...bootstrap.map((record) => record.sequence));
    const suffix = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > cut
    );
    await f.ej.receive('home', suffix);
    await assertRejects(
      () => getAccountData(tenant, 'alice', '', 'm.direct'),
      MatrixError,
      'domain snapshot unavailable',
    );
    for (const record of suffix) await f.es.apply(f.ej, record);
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), {
      suffix: true,
    });
  } finally {
    await f.close();
  }
});

Deno.test('domain admission: retained preparations refuse a newly received suffix at every register owner', async () => {
  const f = await fixture();
  try {
    const bootstrap = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(bootstrap);
    const authority = new FacadeAuth(
      await f.edge.server(),
      f.fp,
      f.node,
      new AuthLinkHealth({ notify: 'websocket', pollseconds: 1 }),
      {
        replicatecredentials: false,
        allowstaleauth: false,
        authmaxstalehours: 1,
      },
    );
    const prepared = await authority.prepare();
    const tenant = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      prepared,
    );
    assertEquals(await getAccountData(tenant, 'alice', '', 'm.direct'), null);
    await putAccountData(f.ht, 'alice', '', 'm.direct', { pending: true });
    const cut = Math.max(...bootstrap.map((record) => record.sequence));
    const suffix = (await f.hs.export('alice', f.bundle.id)).filter((record) =>
      record.sequence > cut
    );
    assertEquals(suffix.length > 0, true);
    await f.ej.receive('home', suffix);
    const intents = [
      () => getAccountData(tenant, 'alice', '', 'm.direct'),
      () => getPublicProfile(tenant, 'alice'),
      () => rulesetFor(tenant, 'alice'),
      () => putAccountData(tenant, 'alice', '', 'm.direct', { stale: true }),
      () => updateRoomTag(tenant, 'alice', '!r:logical.test', 'work', {}),
      () => setProfileField(tenant, 'alice', 'org.example.field', 'stale'),
      () => setDisplayName(tenant, 'alice', 'stale name'),
      () => setAvatarUrl(tenant, 'alice', 'mxc://logical.test/stale'),
      () => setRuleEnabled(tenant, 'alice', 'override', '.m.rule.master', true),
    ];
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const intent of intents) {
      await assertRejects(intent, MatrixError, 'domain snapshot unavailable');
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    for (const record of suffix) await f.es.apply(f.ej, record);
    // Application restores fresh admission, never the earlier retained cut.
    await assertRejects(intents[0], MatrixError, 'domain snapshot unavailable');
    const current = await enrolledTenant(
      f.edge,
      f.fp,
      'logical.test',
      'edge_a',
      authority,
    );
    assertEquals(await getAccountData(current, 'alice', '', 'm.direct'), {
      pending: true,
    });
  } finally {
    await f.close();
  }
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

Deno.test('domain bootstrap review: home restores an authenticated facade-origin fact before declaring completeness', async () => {
  const f = await fixture();
  try {
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'facade-retained-by-home',
    });
    const reverse = await f.es.export('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(
      await getAccountData(f.ht, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'facade-retained-by-home' },
    );
    const operation = (reverse.find((record) =>
      (record.payload as { body: DomainOperation }).body.operation.kind ===
        'account-data'
    )!.payload as { body: DomainOperation }).body.operation;
    // Same missing-owner-fact boundary as the existing authentic-replay test,
    // but this fact was authored here and durably admitted at home.
    await (await f.edge.tenant('logical.test')).execute(
      'DELETE FROM domain_operations WHERE operation_id=?',
      [operation.operationId],
    );
    const bootstrap = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(bootstrap);
    assertEquals(
      (await f.et.tx((tx) =>
        tx.accountData.operations('alice')
      )).some((held) => held.operationId === operation.operationId),
      true,
    );
    assertEquals(
      await f.hs.export('alice', f.bundle.id),
      bootstrap.filter((record) =>
        (record.payload as { body: { kind: string } }).body.kind ===
          'domain-operation'
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test('domain history: every owner restores original facts without new news or export echoes', async () => {
  const f = await fixture();
  try {
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'retained',
    });
    await putAccountData(f.et, 'alice', '!r:logical.test', 'm.tag', {
      tags: { edge: { order: 0.25 } },
    });
    await setProfileField(f.et, 'alice', 'displayname', 'Retained edge');
    await putRule(f.et, 'alice', 'override', 'edge', {
      actions: ['dont_notify'],
      conditions: [],
    }, {});
    await (await f.edge.server()).tx((conn) =>
      recordReceiptOperation(conn, {
        roomId: '!r:logical.test',
        userId: '@alice:logical.test',
        receiptType: 'm.read.private',
        threadId: null,
        eventIds: ['$pending-target'],
        ts: 1,
        admission: { membershipEvent: '$original-join' },
      })
    );
    const reverse = await f.es.export('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    const operations = reverse.map((record) =>
      (record.payload as { body: DomainOperation }).body.operation
    );
    assertEquals([...new Set(operations.map((op) => op.kind))].sort(), [
      'account-data',
      'profile',
      'push-rules',
      'receipt',
      'tags',
    ]);
    const before = await f.et.tx((tx) => tx.streams.heads());
    for (const operation of operations) {
      await (await (operation.kind === 'receipt'
        ? f.edge.server()
        : f.edge.tenant('logical.test'))).execute(
          'DELETE FROM domain_operations WHERE operation_id=?',
          [operation.operationId],
        );
    }
    const records = await f.hs.bootstrap('alice', f.bundle.id);
    await f.toEdge(records);
    const restored = [
      ...await f.et.tx(async (tx) => [
        ...await tx.accountData.operations('alice'),
        ...await tx.profiles.operations('alice'),
        ...await tx.pushRules.operations('alice'),
      ]),
      ...await (await f.edge.server()).tx((conn) =>
        receiptOperations(conn, '@alice:logical.test')
      ),
    ];
    for (const operation of operations) {
      assertEquals(
        restored.find((op) => op.operationId === operation.operationId),
        operation,
      );
    }
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    assertEquals(await f.es.export('alice'), reverse);
    assertEquals(
      await (await f.edge.server()).query(
        "SELECT applied FROM domain_operations WHERE kind='receipt'",
      ),
      [{ applied: 0 }],
    );
    await f.toEdge(records);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
  } finally {
    await f.close();
  }
});

Deno.test('domain history: retained prior-incarnation context permits current successors but not fresh historical authorship', async () => {
  const f = await fixture();
  try {
    // A home-retained owner fact from an earlier enrollment. No current source
    // can author it; bootstrap must preserve that original identity and closure.
    const conn = await f.home.tenant('logical.test');
    const { operation: prior } = await conn.tx((tx) =>
      writeRegister(
        tx,
        { source: 'edge_a', incarnation: 'prior-authenticated-incarnation' },
        JSON.stringify(['account-data', 'alice', '', 'm.secret_storage.key']),
        'account-data',
        JSON.stringify({ ciphertext: 'old-retained' }),
      )
    );
    await putAccountData(f.ht, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'home-successor',
    });
    // Ordinary export can precede the historical predecessor. Its signed
    // successor stays pending rather than blocking the journal before history.
    await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
    assertEquals(
      await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'home-successor' },
    );
    await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
      ciphertext: 'current-successor',
    });
    const reverse = await f.es.export('alice');
    for (const record of reverse) {
      await f.hj.receive(f.node.node, [record]);
      await f.hs.apply(f.hj, record, f.bundle.id);
    }
    assertEquals(
      await getAccountData(f.ht, 'alice', '', 'm.secret_storage.key'),
      { ciphertext: 'current-successor' },
    );
    const retained = (await f.et.tx((tx) => tx.accountData.operations('alice')))
      .find((op) => op.operationId === prior.operationId)!;
    await assertRejects(
      () => f.et.tx((tx) => tx.accountData.import(retained)),
      Error,
      'domain source unavailable',
    );
    // A structurally valid but unknown historical context is not authority.
    const { operation: forged } = await conn.tx((tx) =>
      writeRegister(
        tx,
        { source: 'edge_a', incarnation: 'never-admitted' },
        JSON.stringify(['account-data', 'alice', '', 'm.other']),
        'account-data',
        '{}',
      )
    );
    const { operation: next } = await conn.tx((tx) =>
      writeRegister(
        tx,
        { source: f.node.node, incarnation: f.node.incarnation },
        forged.semanticKey,
        'account-data',
        '{"next":true}',
      )
    );
    const before = await f.et.tx((tx) => tx.streams.heads());
    await f.et.tx((tx) => tx.accountData.import(next));
    assertEquals(await getAccountData(f.et, 'alice', '', 'm.other'), null);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
    // Persisting an unrelated stream's dot cannot authenticate this predecessor.
    await (await f.edge.tenant('logical.test')).tx((tx) =>
      importRegisterOperation(tx, {
        ...forged,
        semanticKey: JSON.stringify([
          'account-data',
          'alice',
          '',
          'm.unrelated',
        ]),
        stream: 'register:' +
          JSON.stringify(['account-data', 'alice', '', 'm.unrelated']),
        operationId: JSON.stringify([
          forged.source,
          forged.incarnation,
          'register:' +
          JSON.stringify(['account-data', 'alice', '', 'm.unrelated']),
          forged.sequence,
        ]),
      })
    );
    await f.et.tx((tx) => tx.accountData.import(next));
    assertEquals(await getAccountData(f.et, 'alice', '', 'm.other'), null);
    assertEquals(await f.et.tx((tx) => tx.streams.heads()), before);
  } finally {
    await f.close();
  }
});

Deno.test('domain history: authenticated current home, account and control bindings precede owner import and ACK', async (t) => {
  for (
    const fault of [
      'signature',
      'payload',
      'account',
      'grant',
      'future-control',
      'source',
      'ordinary-echo',
    ]
  ) {
    await t.step(fault, async () => {
      const f = await fixture();
      try {
        await f.toEdge(await f.hs.bootstrap('alice', f.bundle.id));
        await putAccountData(f.et, 'alice', '', 'm.secret_storage.key', {
          ciphertext: 'retained',
        });
        for (const record of await f.es.export('alice')) {
          await f.hj.receive(f.node.node, [record]);
          await f.hs.apply(f.hj, record, f.bundle.id);
        }
        const records = await f.hs.bootstrap('alice', f.bundle.id);
        const original = records.find((r) =>
          (r.payload as { body: { kind: string } }).body.kind ===
            'domain-history'
        )!;
        const record = structuredClone(original);
        const payload = record.payload as {
          body:
            | DomainOperation
            | import('#engine/facade/domain-control.ts').DomainHistory;
          signature: string;
        };
        if (fault === 'account') payload.body.localpart = 'bob';
        if (fault === 'grant') payload.body.grantRevision++;
        if (fault === 'future-control') payload.body.ownerRevision = 99;
        if (fault === 'source') payload.body.source = 'edge_a';
        if (fault === 'ordinary-echo') payload.body.kind = 'domain-operation';
        if (fault !== 'signature') {
          payload.signature = await f.ht.signer().sign(
            canonicalJson(payload.body),
          );
        } else payload.signature = 'A'.repeat(86);
        if (fault === 'payload') {
          payload.body.operation.payload = '{"ciphertext":"substituted"}';
        }
        record.operationId = (payload.body.kind === 'domain-history'
          ? 'domain-history:'
          : 'domain:') +
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
        const before = await f.ej.heads('home', 'in', record);
        await assertRejects(() =>
          f.es.apply(f.ej, record), LinkError);
        assertEquals(
          (await f.ej.heads('home', 'in', record)).applied,
          before.applied,
        );
        assertEquals(
          await getAccountData(f.et, 'alice', '', 'm.secret_storage.key'),
          { ciphertext: 'retained' },
        );
      } finally {
        await f.close();
      }
    });
  }
});
