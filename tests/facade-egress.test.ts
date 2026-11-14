import { assertEquals, assertRejects } from '@std/assert';
import {
  enqueueEdu,
  freezeBatch,
  frozenBatch,
} from '#engine/server/delivery.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { Journal } from '#engine/facade/journal.ts';
import { type EgressEnvelope, EgressOwner } from '#engine/facade/egress.ts';
import { LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import type { Database } from '#engine/store/db.ts';

const settings = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-egress-owner-' });
  const open = (name: string) =>
    openStore(settings(dir + '/' + name), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
  const home = await open('home');
  let edge = await open('edge');
  const tenant = await openTenant(home, 'logical.test', { create: true });
  const node = await initializeNode(
    await edge.server(),
    'logical.test',
    'edge_a',
  );
  const hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    'a'.repeat(64),
  );
  const fp = async () =>
    new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      'b'.repeat(64),
      node,
    );
  const bundle = await hp.create({
    node: node.node,
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await (await fp()).accept(bundle);
  const grant = await hp.grant(
    bundle.id,
    await (await fp()).challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
  );
  await hp.confirm(
    bundle.id,
    await (await fp()).complete(bundle.id, grant, 'a'.repeat(64)),
  );
  const sent: unknown[] = [];
  let failure = false;
  const owner = async () =>
    new EgressOwner(await edge.server(), await fp(), (envelope) => {
      sent.push(envelope);
      if (failure) return Promise.reject(new Error('uncertain dispatch'));
      return Promise.resolve({ pdus: {} });
    });
  const journal = async () =>
    new Journal(await edge.server(), LINK_CAPABILITIES);
  const hj = new Journal(await home.server(), LINK_CAPABILITIES);
  const envelope: EgressEnvelope = {
    destination: 'remote.test',
    txnId: 'one',
    mode: 'direct',
    body: JSON.stringify(
      { origin: 'logical.test', origin_server_ts: 1, pdus: [], edus: [] },
      null,
      1,
    ),
  };
  const append = async (
    payload: unknown,
    operationId = crypto.randomUUID(),
    incarnation = bundle.id,
  ) => {
    const record = await hj.append(node.node, {
      source: 'home',
      incarnation,
      stream: 'egress:remote.test',
      type: 'egress',
      version: 1,
      operationId,
      payload,
    });
    await (await journal()).receive('home', [record]);
    return record;
  };
  return {
    dir,
    home,
    node,
    bundle,
    hp,
    envelope,
    sent,
    append,
    journal,
    owner,
    db: () => edge.server(),
    fail(value: boolean) {
      failure = value;
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('egress direct grant and result survive cold replay; exact fence is required before next transaction', async () => {
  const f = await fixture();
  try {
    const proposal = await f.append({ kind: 'propose', ...f.envelope });
    assertEquals(
      await (await f.owner()).apply(await f.journal(), proposal),
      true,
    );
    const granted =
      (await (await f.journal()).result('home', 'in', proposal, proposal))!
        .result as { fence: string; response: unknown };
    assertEquals(granted.response, null);
    assertEquals(f.sent, []);
    await f.reopen();
    assertEquals(
      await (await f.owner()).apply(await f.journal(), proposal),
      false,
    );
    const completion = await f.append({
      kind: 'complete',
      ...f.envelope,
      fence: granted.fence,
      response: { pdus: {} },
    });
    assertEquals(
      await (await f.owner()).apply(await f.journal(), completion),
      true,
    );
    const saved = await (await f.journal()).result(
      'home',
      'in',
      completion,
      completion,
    );
    await f.reopen();
    assertEquals(
      await (await f.journal()).result('home', 'in', completion, completion),
      saved,
    );
    assertEquals(
      await (await f.owner()).apply(await f.journal(), completion),
      false,
    );
    const next = await f.append({
      kind: 'propose',
      ...f.envelope,
      txnId: 'two',
    });
    assertEquals(await (await f.owner()).apply(await f.journal(), next), true);
    assertEquals(
      await (await f.db()).query(
        'SELECT txn_id,result_json FROM facade_egress ORDER BY txn_id',
      ),
      [{ txn_id: 'one', result_json: '{"pdus":{}}' }, {
        txn_id: 'two',
        result_json: null,
      }],
    );
  } finally {
    await f.close();
  }
});

Deno.test('egress refuses a second unresolved ID, changed body, invalid response, foreign fence and revoked authority', async (t) => {
  for (
    const kind of ['next', 'changed', 'response', 'fence', 'revoked', 'foreign']
  ) {
    await t.step(kind, async () => {
      const f = await fixture();
      try {
        const proposal = await f.append({ kind: 'propose', ...f.envelope });
        await (await f.owner()).apply(await f.journal(), proposal);
        const grant =
          (await (await f.journal()).result('home', 'in', proposal, proposal))!
            .result as { fence: string };
        const payload = kind === 'next' || kind === 'changed'
          ? {
            kind: 'propose',
            ...f.envelope,
            txnId: kind === 'next' ? 'two' : 'one',
            body: kind === 'changed' ? f.envelope.body + ' ' : f.envelope.body,
          }
          : {
            kind: 'complete',
            ...f.envelope,
            fence: kind === 'fence' ? 'wrong' : grant.fence,
            response: kind === 'response' ? {} : { pdus: {} },
          };
        const record = await f.append(
          payload,
          crypto.randomUUID(),
          kind === 'foreign' ? 'other' : f.bundle.id,
        );
        if (kind === 'revoked') {
          await (await f.db()).execute(
            "UPDATE facade_pairings SET state='revoked'",
          );
        }
        await assertRejects(() =>
          f.owner().then(async (o) => o.apply(await f.journal(), record))
        );
        assertEquals(
          (await (await f.db()).query('SELECT result_json FROM facade_egress'))[
            0
          ].result_json,
          null,
        );
      } finally {
        await f.close();
      }
    });
  }
});

Deno.test('facade dispatch loss retries the identical owner envelope after restart, then retains one result', async () => {
  const f = await fixture();
  try {
    const proposal = await f.append({
      kind: 'propose',
      ...f.envelope,
      mode: 'facade',
    });
    f.fail(true);
    await assertRejects(
      () => f.owner().then(async (o) => o.apply(await f.journal(), proposal)),
      Error,
      'uncertain',
    );
    assertEquals(
      (await (await f.journal()).heads('home', 'in', proposal)).applied
        .sequence,
      0,
    );
    await f.reopen();
    f.fail(false);
    assertEquals(
      await (await f.owner()).apply(await f.journal(), proposal),
      true,
    );
    assertEquals(f.sent[0], f.sent[1]);
    assertEquals(f.sent.length, 2);
    await f.reopen();
    assertEquals(
      await (await f.owner()).apply(await f.journal(), proposal),
      false,
    );
    assertEquals(f.sent.length, 2);
  } finally {
    await f.close();
  }
});

Deno.test('egress migration upgrades v33 without losing frozen bytes', async () => {
  const f = await fixture();
  try {
    await (await f.db()).tx(async (tx) => {
      await tx.exec(
        'DROP TABLE facade_egress; DROP TABLE facade_egress_routes',
      );
      await tx.execute("UPDATE meta SET v='33' WHERE k='schema_version'");
    }, { mode: 'deferred' });
    await f.reopen();
    const record = await f.append({ kind: 'propose', ...f.envelope });
    assertEquals(
      await (await f.owner()).apply(await f.journal(), record),
      true,
    );
    assertEquals(
      (await (await f.db()).query('SELECT body FROM facade_egress'))[0].body,
      f.envelope.body,
    );
    await assertRejects(async () => {
      await (await f.db()).execute(
        'INSERT INTO facade_egress(destination,txn_id,body,mode,pairing,fence) VALUES(?,?,?,?,?,?)',
        ['remote.test', 'two', '{}', 'direct', f.bundle.id, 'other'],
      );
    });
  } finally {
    await f.close();
  }
});

Deno.test('facade completed dispatch is not repeated after journal completion interruption', async () => {
  const f = await fixture();
  try {
    const record = await f.append({
      kind: 'propose',
      ...f.envelope,
      mode: 'facade',
    });
    const db = await f.db();
    const broken: Database = {
      ...db,
      tx: (fn, options) =>
        db.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, property) {
                if (property === 'execute') {
                  return (
                    sql: string,
                    args: Parameters<typeof conn.execute>[1],
                  ) => {
                    if (
                      sql.startsWith('UPDATE facade_records SET result_json')
                    ) throw new Error('interrupted journal completion');
                    return conn.execute(sql, args);
                  };
                }
                const value = Reflect.get(target, property);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
    await assertRejects(
      () =>
        f.owner().then((owner) =>
          owner.apply(new Journal(broken, LINK_CAPABILITIES), record)
        ),
      Error,
      'interrupted journal',
    );
    assertEquals(f.sent.length, 1);
    assertEquals(
      (await (await f.journal()).heads('home', 'in', record)).applied.sequence,
      0,
    );
    await f.reopen();
    assertEquals(
      await (await f.owner()).apply(await f.journal(), record),
      true,
    );
    assertEquals(f.sent.length, 1);
    const result =
      (await (await f.journal()).result('home', 'in', record, record))!
        .result as { response: unknown };
    assertEquals(result.response, { pdus: {} });
  } finally {
    await f.close();
  }
});

Deno.test('distributed frozen batch survives local selection retirement and cold reopen', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'facade-egress-' });
  let store = await openStore(settings(dir), {
    schemas: { server: serverSchema },
  });
  try {
    let db = await store.server();
    await db.tx((tx) => enqueueEdu(tx, 'one', 'remote.test', 'm.test', {}));
    const batch = {
      txnId: 'uncertain',
      body: '{"exact":true}',
      rows: [],
      sources: ['one'],
    };
    assertEquals(await freezeBatch(db, 'remote.test', batch), true);
    await db.execute("UPDATE edu_outbox SET state='sent'");
    await store.close();
    store = await openStore(settings(dir), {
      schemas: { server: serverSchema },
    });
    db = await store.server();
    assertEquals(await frozenBatch(db, 'remote.test', true), batch);
    assertEquals(await frozenBatch(db, 'remote.test'), null);
  } finally {
    await store.close();
    await Deno.remove(dir, { recursive: true });
  }
});
