import { assertEquals, assertRejects } from '@std/assert';
import {
  enqueueEdu,
  freezeBatch,
  frozenBatch,
} from '#engine/server/delivery.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { historicalServerSchema } from './fixtures/server-schema-history.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { Journal } from '#engine/facade/journal.ts';
import { type EgressEnvelope, EgressOwner } from '#engine/facade/egress.ts';
import { LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import type { Database } from '#engine/store/db.ts';
import { HomeEgress } from '#engine/facade/home-egress.ts';
import type { Dispatch } from '#engine/server/delivery.ts';
import { startSender } from '#engine/federation/sender.ts';
import { bounded } from './helpers/server-process.ts';
import { config } from '#engine/config.ts';
import { upsertDevice } from '#engine/tenant/devices.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';

function localDispatch(owner: EgressOwner): Dispatch {
  const dispatch = Reflect.get(owner, 'dispatchLocal');
  assertEquals(
    typeof dispatch,
    'function',
    'destination owner must publish facade-authored work',
  );
  return dispatch.bind(owner);
}

const settings = (dir: string) => ({
  dir,
  library: './.native/libturso_ffi.so',
  checkpointlogbytes: 65536,
  maxopenfiles: 8,
  idleseconds: 300,
});

async function fixture(seedServer = serverSchema) {
  const dir = await Deno.makeTempDir({ prefix: 'facade-egress-owner-' });
  const open = (name: string, schema = serverSchema) =>
    openStore(settings(dir + '/' + name), {
      schemas: { server: schema, tenant: tenantSchema },
    });
  const home = await open('home', seedServer);
  let edge = await open('edge', seedServer);
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
    store: () => edge,
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

Deno.test('facade local egress waits for the exact home result, then publishes through the same destination slot', async () => {
  const f = await fixture();
  try {
    const home = await f.append({ kind: 'propose', ...f.envelope });
    await (await f.owner()).apply(await f.journal(), home);
    const grant = (await (await f.journal()).result('home', 'in', home, home))!
      .result as { fence: string };
    const local = { ...f.envelope, txnId: 'local' };
    const owner = await f.owner();
    const dispatch = localDispatch(owner);
    await assertRejects(() => dispatch(local));
    assertEquals(f.sent, []);
    const completed = await f.append({
      kind: 'complete',
      ...f.envelope,
      fence: grant.fence,
      response: { pdus: {} },
    });
    await (await f.owner()).apply(await f.journal(), completed);
    assertEquals(await localDispatch(await f.owner())(local), { pdus: {} });
    assertEquals(f.sent, [{ ...local, mode: 'facade' }]);
    await f.reopen();
    assertEquals(await localDispatch(await f.owner())(local), { pdus: {} });
    assertEquals(
      f.sent.length,
      1,
      'cold receipt replay must not dispatch again',
    );
  } finally {
    await f.close();
  }
});

Deno.test('facade local egress retains uncertain bytes across restart and blocks a newer home proposal', async () => {
  const f = await fixture();
  try {
    const local = { ...f.envelope, txnId: 'local' };
    f.fail(true);
    await assertRejects(
      () => f.owner().then((owner) => localDispatch(owner)(local)),
      Error,
      'uncertain',
    );
    const home = await f.append({ kind: 'propose', ...f.envelope });
    await assertRejects(() =>
      f.owner().then(async (owner) => owner.apply(await f.journal(), home))
    );
    await f.reopen();
    await assertRejects(() =>
      f.owner().then((owner) =>
        localDispatch(owner)({ ...local, body: local.body + ' ' })
      )
    );
    assertEquals(f.sent.length, 1);
    f.fail(false);
    assertEquals(await localDispatch(await f.owner())(local), { pdus: {} });
    assertEquals(f.sent[0], f.sent[1]);
    assertEquals(await (await f.owner()).apply(await f.journal(), home), true);
  } finally {
    await f.close();
  }
});

Deno.test('facade local egress publishes an ordinary sender device EDU only after the home lease completes', async () => {
  const f = await fixture();
  let sender: ReturnType<typeof startSender> | undefined;
  try {
    const home = await f.append({ kind: 'propose', ...f.envelope });
    await (await f.owner()).apply(await f.journal(), home);
    const grant = (await (await f.journal()).result('home', 'in', home, home))!
      .result as { fence: string };
    const content = {
      user_id: '@alice:logical.test',
      device_id: 'PHONE',
      stream_id: 8,
      prev_id: [11, 6],
      keys: { device_id: 'PHONE' },
    };
    await (await f.db()).tx((tx) =>
      enqueueEdu(
        tx,
        'local-device',
        'remote.test',
        'm.device_list_update',
        content,
      )
    );
    const blocked = Promise.withResolvers<void>(),
      delivered = Promise.withResolvers<void>();
    const owner = await f.owner();
    sender = startSender({
      store: f.store(),
      signer: f.node.signer(),
      dispatch: async (envelope) => {
        try {
          return await owner.dispatchLocal(envelope);
        } catch (error) {
          blocked.resolve();
          throw error;
        }
      },
      onDelivered: () => {
        delivered.resolve();
        return Promise.resolve();
      },
    });
    await bounded(blocked.promise);
    assertEquals(f.sent, []);
    const completed = await f.append({
      kind: 'complete',
      ...f.envelope,
      fence: grant.fence,
      response: { pdus: {} },
    });
    await owner.apply(await f.journal(), completed);
    sender.wake('remote.test');
    await bounded(delivered.promise);
    assertEquals(f.sent.length, 1);
    const envelope = f.sent[0] as EgressEnvelope;
    assertEquals(JSON.parse(envelope.body).edus, [{
      edu_type: 'm.device_list_update',
      content,
    }]);
    assertEquals(
      await (await f.db()).query('SELECT * FROM federation_batches'),
      [],
    );
    assertEquals(await (await f.db()).query('SELECT * FROM edu_outbox'), []);
  } finally {
    await sender?.stop();
    await f.close();
  }
});

Deno.test('to-device tenant intent follows the shared egress lease, uncertain bytes and durable result through cold restart', async () => {
  const f = await fixture();
  let sender: ReturnType<typeof startSender> | undefined;
  try {
    const tenant = await openTenant(f.store(), 'logical.test', {
      create: true,
    });
    await tenant.tx((tx) => tx.users.insert('alice', 'Alice'));
    await upsertDevice(tenant, 'alice', 'PHONE');
    const device = await deviceIdentity(tenant, 'alice', 'PHONE');
    const messages = [{
      user: '@bob:remote.test',
      id: '*',
      content: { ciphertext: 'original' },
    }];
    await tenant.tx((tx) =>
      tx.toDevice.send(
        device,
        'logical.test',
        'm.room.encrypted',
        'client-txn',
        'logical-message',
        messages,
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    const intent = await (await f.store().tenant('logical.test')).query(
      'SELECT * FROM to_device_intents',
    );
    assertEquals(intent.length, 1);
    assertEquals(intent[0].projected, 0);
    assertEquals(await (await f.db()).query('SELECT * FROM edu_outbox'), []);
    const home = await f.append({ kind: 'propose', ...f.envelope });
    await (await f.owner()).apply(await f.journal(), home);
    const grant = (await (await f.journal()).result('home', 'in', home, home))!
      .result as { fence: string };
    await projectTenant(f.store(), 'logical.test');
    const source = 'tenant:logical.test:to-device:logical-message:remote.test';
    assertEquals(
      await (await f.db()).query('SELECT source,state FROM edu_outbox'),
      [{ source, state: 'pending' }],
    );
    // No direct transport is available: every attempt goes through the owner.
    const run = async (afterOwner = false) => {
      const attempted = Promise.withResolvers<void>();
      const owner = await f.owner();
      sender = startSender({
        store: f.store(),
        signer: f.node.signer(),
        dispatch: async (envelope) => {
          try {
            const result = await owner.dispatchLocal(envelope);
            if (afterOwner) throw new Error('lost local outbox completion');
            return result;
          } finally {
            attempted.resolve();
          }
        },
        onDelivered: () => projectTenant(f.store(), 'logical.test'),
      });
      await bounded(attempted.promise);
      await sender.stop();
      sender = undefined;
    };
    await run();
    assertEquals(
      f.sent,
      [],
      'home lease must block the actual to-device batch',
    );
    const frozen = await frozenBatch(await f.db(), 'remote.test', true);
    assertEquals(frozen?.sources, [source]);
    assertEquals(JSON.parse(frozen!.body).edus, [{
      edu_type: 'm.direct_to_device',
      content: {
        sender: '@alice:logical.test',
        type: 'm.room.encrypted',
        message_id: 'logical-message',
        messages: { '@bob:remote.test': { '*': { ciphertext: 'original' } } },
      },
    }]);
    await f.reopen();
    const completed = await f.append({
      kind: 'complete',
      ...f.envelope,
      fence: grant.fence,
      response: { pdus: {} },
    });
    await (await f.owner()).apply(await f.journal(), completed);
    f.fail(true);
    await run();
    assertEquals(f.sent.length, 1);
    assertEquals(await frozenBatch(await f.db(), 'remote.test', true), frozen);
    assertEquals(
      (await (await f.store().tenant('logical.test')).query(
        'SELECT * FROM to_device_intents',
      )).length,
      1,
    );
    await f.reopen();
    f.fail(false);
    await run(true);
    assertEquals(f.sent.length, 2);
    assertEquals(
      f.sent[0],
      f.sent[1],
      'uncertain retry must retain the exact ID and bytes',
    );
    assertEquals(await frozenBatch(await f.db(), 'remote.test', true), frozen);
    assertEquals(
      (await (await f.db()).query(
        'SELECT result_json FROM facade_egress WHERE txn_id=?',
        [frozen!.txnId],
      ))[0].result_json,
      '{"pdus":{}}',
    );
    await f.reopen();
    const reopened = await openTenant(f.store(), 'logical.test');
    await reopened.tx((tx) =>
      tx.toDevice.send(
        device,
        'logical.test',
        'm.room.encrypted',
        'client-txn',
        'changed-source',
        [{ ...messages[0], content: { changed: true } }],
        config().e2ee,
        { enabled: true, maxBytes: 1048576 },
      )
    );
    await projectTenant(f.store(), 'logical.test');
    assertEquals(
      (await (await f.store().tenant('logical.test')).query(
        'SELECT * FROM to_device_intents',
      )).length,
      1,
    );
    const delivered = Promise.withResolvers<void>();
    const owner = await f.owner();
    sender = startSender({
      store: f.store(),
      signer: f.node.signer(),
      dispatch: (envelope) => owner.dispatchLocal(envelope),
      onDelivered: async () => {
        await projectTenant(f.store(), 'logical.test');
        delivered.resolve();
      },
    });
    await bounded(delivered.promise);
    await sender.stop();
    sender = undefined;
    assertEquals(
      f.sent.length,
      2,
      'saved owner result must complete local ACK without retransmission',
    );
    assertEquals(
      await (await f.store().tenant('logical.test')).query(
        'SELECT * FROM to_device_intents',
      ),
      [],
    );
    assertEquals(await (await f.db()).query('SELECT * FROM edu_outbox'), []);
    assertEquals(await frozenBatch(await f.db(), 'remote.test', true), null);
    await f.reopen();
    await projectTenant(f.store(), 'logical.test');
    assertEquals(await (await f.db()).query('SELECT * FROM edu_outbox'), []);
  } finally {
    await sender?.stop();
    await f.close();
  }
});

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

Deno.test('egress migration upgrades v34 without losing frozen bytes', async () => {
  const f = await fixture(historicalServerSchema(35));
  try {
    await (await f.db()).tx(async (tx) => {
      await tx.exec(
        'DROP TABLE facade_egress; DROP TABLE facade_egress_routes',
      );
      await tx.execute("UPDATE meta SET v='34' WHERE k='schema_version'");
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

Deno.test('home egress persists completion before ACK, resumes original mode, and never promotes a replacement owner', async () => {
  const f = await fixture();
  try {
    const db = await f.home.server();
    const journal = new Journal(db, LINK_CAPABILITIES);
    let calls = 0;
    const home = (
      mode: 'direct' | 'facade' = 'direct',
      nodes = [f.node.node],
    ) =>
      new HomeEgress(db, f.hp, journal, nodes, mode, () => {
        calls++;
        return Promise.resolve({ pdus: {} });
      }, () => {});
    const pump = async () => {
      for (const stream of await journal.streams(f.node.node, 'out')) {
        const edge = await f.journal();
        const head = await edge.heads('home', 'in', stream);
        const page = await journal.page(
          f.node.node,
          'out',
          stream,
          head.received.sequence,
          { maxItems: 100, maxBytes: 1000000 },
        );
        if (page.records.length) await edge.receive('home', page.records);
        while (
          await (await f.owner()).apply(edge, stream)
        ) { /* drain this stream */ }
        const after = await journal.acknowledged(f.node.node, stream);
        const ack = await edge.acknowledgement('home', stream, after.applied, {
          maxItems: 100,
          maxBytes: 1000000,
        });
        await journal.ack(
          f.node.node,
          stream,
          ack.received,
          ack.applied,
          ack.results,
        );
      }
    };
    await assertRejects(() => home().dispatch(f.envelope), Error, 'awaits');
    assertEquals(calls, 0);
    await pump();
    await assertRejects(() => home().dispatch(f.envelope), Error, 'awaits');
    assertEquals(calls, 1);
    // Reconstructed coordinator with changed config must use the immutable
    // proposal's dispatcher and its already retained completion, not redial.
    await assertRejects(
      () => home('facade').dispatch(f.envelope),
      Error,
      'awaits',
    );
    assertEquals(calls, 1);
    await f.reopen();
    await pump();
    assertEquals(await home('facade').dispatch(f.envelope), { pdus: {} });
    assertEquals(calls, 1);
    await assertRejects(
      () =>
        home('direct', ['replacement']).dispatch({
          ...f.envelope,
          txnId: 'two',
        }),
      Error,
      'awaits',
    );
    await assertRejects(
      () => home('direct', []).dispatch({ ...f.envelope, txnId: 'two' }),
      Error,
      'awaits',
    );
    assertEquals(
      await db.query('SELECT peer,pairing FROM facade_egress_routes'),
      [{ peer: f.node.node, pairing: f.bundle.id }],
    );
    assertEquals(
      (await journal.streams(f.node.node, 'out'))[0].received.sequence,
      2,
    );
  } finally {
    await f.close();
  }
});
