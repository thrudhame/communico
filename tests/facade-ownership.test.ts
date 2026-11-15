import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { capabilities } from '#engine/facade/capabilities.ts';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { Journal } from '#engine/facade/journal.ts';
import {
  exportOwnerControl,
  OwnerControls,
  publicationIdentity,
} from '#engine/facade/ownership.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
  LinkError,
} from '#engine/facade/protocol.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  OWNER_CONTROL_SQL,
  PUBLICATION_DOMAIN_SQL,
} from '#engine/facade/schema.ts';
import type { SchemaProvider } from '#engine/store/create.ts';
import { historicalTenantSchema } from './fixtures/tenant-schema-history.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-ownership-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
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
  let fp = new Pairings(
    await edge.server(),
    node.signer(),
    node.publicKey,
    'b'.repeat(64),
    node,
  );
  let bundle;
  async function enroll() {
    bundle = await hp.create({
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
    return bundle;
  }
  let binding = await enroll();
  await enrolledTenant(edge, fp, 'logical.test', 'edge_a');
  const journal = async (supported = LINK_SUPPORTED) =>
    new Journal(await edge.server(), supported);
  const owner = async () =>
    new OwnerControls(
      await edge.server(),
      await edge.tenant('logical.test'),
      fp,
      node,
    );
  const emit = () => exportOwnerControl(home, tenant, hp, binding.id);
  return {
    home,
    tenant,
    node,
    hp,
    edge: () => edge,
    pairings: () => fp,
    owner,
    journal,
    emit,
    async receive() {
      const record = await emit();
      await (await journal()).receive('home', [record]);
      return record;
    },
    async reenroll() {
      await fp.retire(await hp.revoke(binding.id), 'a'.repeat(64));
      binding = await enroll();
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
      fp = new Pairings(
        await edge.server(),
        node.signer(),
        node.publicKey,
        'b'.repeat(64),
        node,
      );
    },
    async changed(payload: unknown, operation: string) {
      const grant = await fp.active();
      return await new Journal(await home.server(), LINK_SUPPORTED).append(
        'edge_a',
        {
          source: 'home',
          incarnation: grant.body.transcript.body.context.id,
          stream: 'owner-control',
          type: 'owner-control',
          version: 1,
          operationId: operation,
          payload,
        },
      );
    },
    async close() {
      await home.close();
      await edge.close();
      await Deno.remove(dir, { recursive: true });
    },
  };
}

Deno.test('F2 ownership control is signed, durable, first-ingress and isolated from F1 capability requirements', async () => {
  const f = await fixture();
  try {
    const old = await f.journal(LINK_CAPABILITIES);
    const record = await f.emit();
    await assertRejects(
      () => old.receive('home', [record]),
      LinkError,
      'unsupported record type',
    );
    assertEquals(await old.streams('home', 'in'), []);
    const journal = await f.journal();
    await journal.receive('home', [record]);
    const owner = await f.owner();
    await assertRejects(
      () => owner.ready(),
      MatrixError,
      'ownership control unavailable',
    );
    assertEquals(await owner.apply(journal, record), true);
    const body = await owner.ready();
    assertEquals(body.policy, 'first-ingress');
    assertEquals(body.collision, 'home-wins');
    assertEquals(body.nodes.map((n) => [n.node, n.lane]), [
      ['home', { offset: 1, stride: 2 }],
      ['edge_a', { offset: 2, stride: 2 }],
    ]);
    assertEquals(
      await f.emit(),
      record,
      'unchanged control emits no new journal record',
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      record.sequence,
    );
    const domain = await publicationIdentity(await f.edge().server(), 'edge_a');
    await f.reopen();
    assertEquals(
      await publicationIdentity(await f.edge().server(), 'edge_a'),
      domain,
    );
    assertEquals(await (await f.owner()).ready(), body);
    assertEquals(
      await (await f.owner()).apply(await f.journal(), record),
      false,
    );
    assertEquals(
      capabilities('facade').gate(
        new Request('https://logical.test/_matrix/client/v3/login', {
          method: 'POST',
        }),
        () => true,
      )?.status,
      404,
    );
    assert(!canonicalJson(record).includes('private_key'));
    assert(!canonicalJson(record).includes('secretHash'));
  } finally {
    await f.close();
  }
});

Deno.test('owner readiness revalidates authority after asynchronous activation reads', async () => {
  const f = await fixture();
  try {
    const record = await f.receive();
    await (await f.owner()).apply(await f.journal(), record);
    const server = await f.edge().server();
    const grant = await f.pairings().active();
    let revoked = false;
    const owner = new OwnerControls(
      {
        ...server,
        query: async (...args: Parameters<typeof server.query>) => {
          const rows = await server.query(...args);
          if (!revoked && args[0].includes('facade_owner_activation')) {
            revoked = true;
            await f.pairings().retire(
              await f.hp.revoke(grant.body.transcript.body.context.id),
              'a'.repeat(64),
            );
          }
          return rows;
        },
      },
      await f.edge().tenant('logical.test'),
      f.pairings(),
      f.node,
    );
    await assertRejects(
      () => owner.ready(),
      LinkError,
      'ownership grant changed',
    );
    assert(revoked);
  } finally {
    await f.close();
  }
});

Deno.test('control rejects forged authority, same-revision substitution and revision regression without apply ACK', async () => {
  const f = await fixture();
  try {
    const initial = await f.receive();
    const journal = await f.journal();
    const owner = await f.owner();
    await owner.apply(journal, initial);
    const baseline = await owner.ready();
    const payload = structuredClone(initial.payload) as {
      body: Record<string, unknown>;
      signature: string;
    };
    payload.body.revision = baseline.revision + 1;
    const forged = await f.changed(payload, 'forged');
    await journal.receive('home', [forged]);
    await assertRejects(
      () => owner.apply(journal, forged),
      LinkError,
      'signature',
    );
    assertEquals(
      (await journal.heads('home', 'in', forged)).applied.sequence,
      initial.sequence,
    );
    assertEquals(await owner.ready(), baseline);
    // Inspect signed candidates directly through distinct streams/fixtures below:
    // a blocked source record cannot be skipped to make its successor pass.
  } finally {
    await f.close();
  }
});

for (
  const kind of [
    'substitution',
    'regression',
    'wrong-incarnation',
    'unsupported',
  ] as const
) {
  Deno.test(`owner-control refuses signed ${kind} before local activation`, async () => {
    const f = await fixture();
    try {
      const initial = await f.receive();
      const owner = await f.owner();
      const journal = await f.journal();
      await owner.apply(journal, initial);
      const body = structuredClone(
        (initial.payload as { body: Record<string, unknown> }).body,
      );
      let last = initial;
      if (kind === 'substitution') {
        (body.nodes as { incarnation: string }[])[0].incarnation =
          'different-home-incarnation';
      }
      if (kind === 'regression') {
        const newer = { ...body, revision: 2 };
        last = await f.changed({
          body: newer,
          signature: await f.tenant.signer().sign(canonicalJson(newer)),
        }, 'newer');
        await journal.receive('home', [last]);
        await owner.apply(journal, last);
      }
      if (kind === 'wrong-incarnation') {
        const nodes = body.nodes as { incarnation: string }[];
        nodes[1].incarnation = 'restored-other-store';
        body.revision = Number(body.revision) + 1;
      }
      if (kind === 'unsupported') {
        body.required = [{ type: 'account-auth', version: 99 }];
        body.revision = Number(body.revision) + 1;
      }
      const record = await f.changed({
        body,
        signature: await f.tenant.signer().sign(canonicalJson(body)),
      }, kind);
      await journal.receive('home', [record]);
      await assertRejects(() => owner.apply(journal, record), LinkError);
      assertEquals(
        (await journal.heads('home', 'in', record)).applied.sequence,
        last.sequence,
      );
      assertEquals(
        (await owner.ready()).revision,
        kind === 'regression' ? 2 : 1,
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test('cross-file mixed control remains unavailable and replays to completion after cold reopen', async () => {
  const f = await fixture();
  try {
    const record = await f.receive();
    const tenantDb = await f.edge().tenant('logical.test');
    const broken = new OwnerControls(
      await f.edge().server(),
      {
        ...tenantDb,
        tx: () => Promise.reject(new Error('injected tenant commit failure')),
      },
      f.pairings(),
      f.node,
    );
    const journal = await f.journal();
    await assertRejects(
      () => broken.apply(journal, record),
      Error,
      'injected tenant',
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
    await assertRejects(
      () => (f.owner()).then((owner) => owner.ready()),
      MatrixError,
    );
    await f.reopen();
    await (await f.owner()).apply(await f.journal(), record);
    assertEquals((await (await f.owner()).ready()).revision, 1);
    assertEquals(
      (await (await f.journal()).heads('home', 'in', record)).applied.sequence,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('ownership schemas upgrade actual server35/tenant21 to the same schema as fresh creation', async () => {
  const dir = await Deno.makeTempDir({ prefix: 'owner-control-upgrade-' });
  const cfg = (suffix: string) => ({
    dir: dir + '/' + suffix,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  // Omit only this slice's appended creation statements, preserving the actual
  // previous provider. Do not relabel today's full schema with an old version.
  const prior = (current: SchemaProvider, version: number): SchemaProvider => ({
    version,
    migrations: current.migrations,
    apply: (conn) =>
      current.apply(
        {
          query: conn.query.bind(conn),
          execute: conn.execute.bind(conn),
          exec: (sql: string) =>
            sql === OWNER_CONTROL_SQL || sql === PUBLICATION_DOMAIN_SQL
              ? Promise.resolve()
              : conn.exec(sql),
        } as typeof conn,
      ),
  });
  let old = await openStore(cfg('upgrade'), {
    schemas: {
      server: prior(serverSchema, 35),
      tenant: historicalTenantSchema(21),
    },
  });
  const fresh = await openStore(cfg('fresh'), {
    schemas: { server: serverSchema, tenant: tenantSchema },
  });
  try {
    const t = await openTenant(old, 'logical.test', { create: true });
    await t.tx((tx) => tx.users.insert('existing', 'Existing'));
    const key = t.publicB64;
    const ft = await openTenant(fresh, 'logical.test', { create: true });
    assert(ft.publicB64);
    await old.close();
    old = await openStore(cfg('upgrade'), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
    assertEquals((await openTenant(old, 'logical.test')).publicB64, key);
    for (const kind of ['server', 'tenant'] as const) {
      const left = kind === 'server'
        ? await old.server()
        : await old.tenant('logical.test');
      const right = kind === 'server'
        ? await fresh.server()
        : await fresh.tenant('logical.test');
      const sql =
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name";
      assertEquals(await left.query(sql), await right.query(sql));
    }
    assertEquals(
      (await openTenant(old, 'logical.test')).serverName,
      'logical.test',
    );
  } finally {
    await old.close();
    await fresh.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test('re-enrollment fences old ownership control and preserves independent publication identity', async () => {
  const f = await fixture();
  try {
    const record = await f.receive();
    await (await f.owner()).apply(await f.journal(), record);
    const domain = await publicationIdentity(await f.edge().server(), 'edge_a');
    await f.reenroll();
    await assertRejects(
      () => (f.owner()).then((owner) => owner.ready()),
      MatrixError,
    );
    const next = await f.receive();
    await (await f.owner()).apply(await f.journal(), next);
    assertEquals((await (await f.owner()).ready()).pairing, next.incarnation);
    assertEquals(
      await publicationIdentity(await f.edge().server(), 'edge_a'),
      domain,
    );
    const server = await f.edge().server();
    await assertRejects(() => publicationIdentity(server, 'other'), LinkError);
  } finally {
    await f.close();
  }
});

Deno.test('revocation at the journal completion transaction cannot ACK installed ownership authority', async () => {
  const f = await fixture();
  try {
    const record = await f.emit();
    const server = await f.edge().server();
    const tenant = await f.edge().tenant('logical.test');
    let armed = false;
    const journal = new Journal({
      ...server,
      tx: async (fn, options) => {
        if (armed) {
          armed = false;
          await server.execute(
            "UPDATE facade_pairings SET state='revoked' WHERE id=?",
            [record.incarnation],
          );
        }
        return await server.tx(fn, options);
      },
    }, LINK_SUPPORTED);
    await journal.receive('home', [record]);
    const owner = new OwnerControls(
      server,
      {
        ...tenant,
        tx: async (fn, options) => {
          const result = await tenant.tx(fn, options);
          armed = true;
          return result;
        },
      },
      f.pairings(),
      f.node,
    );
    await assertRejects(
      () => owner.apply(journal, record),
      LinkError,
      'grant changed',
    );
    assertEquals(
      (await journal.heads('home', 'in', record)).applied.sequence,
      0,
    );
  } finally {
    await f.close();
  }
});
