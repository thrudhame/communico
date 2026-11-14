import { assert, assertEquals, assertRejects } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { type IngressObligation, Mailbox } from '#engine/facade/mailbox.ts';
import { initializeNode } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { Journal } from '#engine/facade/journal.ts';
import { LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import { keyStore } from '#engine/federation/keys.ts';
import { captureRequestEvidence } from '#engine/federation/request-evidence.ts';
import { requestCanonical } from '#engine/federation/request-signature.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { signJson } from '#engine/signing-primitives.js';
import { directOnly, makeDoc } from './federation/doc-helper.ts';
import { genesis } from './fixtures/genesis.ts';
import { authAt } from './fixtures/auth.ts';
import {
  fakeFetcher,
  fakeKeyResolver,
  makeRemoteServer,
  remoteEvent,
} from './fixtures/remote.ts';

installServerHooks();

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-mailbox-' });
  const open = (name: string) =>
    openStore({
      dir: dir + '/' + name,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, {
      schemas: { server: serverSchema, room: roomSchema, tenant: tenantSchema },
    });
  const home = await open('home');
  let edge = await open('edge');
  const g = await genesis(edge, {
    roomId: '!mailbox:test',
    joinRule: 'public',
  });
  const self = g.signer.serverName;
  const tenant = await openTenant(home, self, { create: true });
  const node = await initializeNode(await edge.server(), self, 'edge_a');
  const hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    'a'.repeat(64),
  );
  const pairings = async () =>
    new Pairings(
      await edge.server(),
      node.signer(),
      node.publicKey,
      'b'.repeat(64),
      node,
    );
  const fp = await pairings();
  const bundle = await hp.create({
    node: node.node,
    url: 'https://facade.test',
    facadePin: 'b'.repeat(64),
    expires: Date.now() + 60000,
    required: [...LINK_CAPABILITIES],
  });
  await fp.accept(bundle);
  const grant = await hp.grant(
    bundle.id,
    await fp.challenge(bundle.id, bundle.secret, 'a'.repeat(64)),
  );
  await hp.confirm(
    bundle.id,
    await fp.complete(bundle.id, grant, 'a'.repeat(64)),
  );
  const remote = await makeRemoteServer('remote.test');
  const doc = await makeDoc(remote);
  let accepted = 0;
  let fail: ((sql: string, args: readonly unknown[]) => boolean) | undefined;
  let blocked = false;
  const db = async (): Promise<Database> => {
    const real = await edge.server();
    return {
      ...real,
      tx: (fn, options) =>
        real.tx((conn) =>
          fn(
            new Proxy(conn, {
              get(target, prop) {
                if (prop === 'execute') {
                  return (sql: string, args: readonly unknown[] = []) => {
                    if (fail?.(sql, args)) {
                      fail = undefined;
                      throw new Error('injected commit interruption');
                    }
                    return conn.execute(
                      sql,
                      args as Parameters<Conn['execute']>[1],
                    );
                  };
                }
                const value = Reflect.get(target, prop);
                return typeof value === 'function' ? value.bind(target) : value;
              },
            }),
          ), options),
    };
  };
  const mailbox = async () =>
    new Mailbox(await db(), {
      self,
      node,
      pairings: await pairings(),
      transaction: {
        self,
        store: edge,
        keys: fakeKeyResolver(remote),
        fetcher: fakeFetcher({}).fetcher,
        edus: { dispatch: () => Promise.resolve() },
      },
      requireScope: () =>
        blocked
          ? Promise.reject(
            new MatrixError(503, 'M_UNAVAILABLE', 'scope not ready'),
          )
          : Promise.resolve(),
      acceptEdu: () => {
        accepted++;
        return Promise.resolve({ kind: 'retained' });
      },
      changed() {},
    });
  const evidence = async (
    txnId: string,
    pdus: Pdu[] = [],
    edus: unknown[] = [{
      edu_type: 'm.direct_to_device',
      content: { test: true },
    }],
  ) => {
    const req = {
      method: 'PUT',
      uri: '/_matrix/federation/v1/send/' + encodeURIComponent(txnId) +
        '?original=yes',
      authorization: '',
      body: new TextEncoder().encode(
        JSON.stringify(
          { origin: remote.name, origin_server_ts: 1, pdus, edus },
          null,
          1,
        ),
      ),
    };
    const signed = JSON.parse(requestCanonical(self, req, remote.name));
    await signJson(signed, remote.name, remote.keyId, remote.kp.privateKey);
    req.authorization =
      `X-Matrix origin="${remote.name}",destination="${self}",key="${remote.keyId}",sig="${
        signed.signatures[remote.name][remote.keyId]
      }"`;
    const keys = keyStore(await edge.server(), { deps: directOnly(doc) });
    const publicKey = await keys.getVerifyKey(
      remote.name,
      remote.keyId,
      Date.now(),
      'request',
    );
    return await captureRequestEvidence(keys, self, req, {
      origin: remote.name,
      keyId: remote.keyId,
      publicKey,
    });
  };
  return {
    self,
    remote,
    g,
    node,
    mailbox,
    evidence,
    edge: () => edge,
    accepted: () => accepted,
    block(value: boolean) {
      blocked = value;
    },
    fail(match: NonNullable<typeof fail>) {
      fail = match;
    },
    async reopen() {
      await edge.close();
      edge = await open('edge');
    },
    async close() {
      await edge.close();
      await home.close();
      await Deno.remove(dir, { recursive: true });
      setConfigForTests({});
    },
    async join() {
      const sender = '@remote:' + remote.name;
      const fields = {
        type: 'm.room.member',
        sender,
        state_key: sender,
        content: { membership: 'join' },
      };
      return await remoteEvent(g.roomId, remote, '11', {
        ...fields,
        prev_events: [g.tipId],
        auth_events: await authAt(g.room, fields, g.tipId),
      });
    },
  };
}

Deno.test('mailbox commits the exact complete answer and home obligation atomically across cold retry', async () => {
  const f = await fixture();
  try {
    const proof = await f.evidence('complete');
    let box = await f.mailbox();
    await box.stage('complete', proof);
    await box.stage('complete', await f.evidence('complete'));
    f.fail((sql) => sql.startsWith('UPDATE facade_ingress SET response_json='));
    await assertRejects(
      () => box.receive(f.remote.name, 'complete'),
      MatrixError,
    );
    let server = await f.edge().server();
    assertEquals(
      await server.query(
        "SELECT * FROM facade_records WHERE stream LIKE 'ingress:%'",
      ),
      [],
    );
    assertEquals(f.accepted(), 1);
    assertEquals(
      (await server.query('SELECT response_json FROM facade_ingress'))[0]
        .response_json,
      null,
    );
    await f.reopen();
    box = await f.mailbox();
    const result = await box.receive(f.remote.name, 'complete');
    assertEquals(result, { status: 200, body: { pdus: {} } });
    assertEquals(await box.receive(f.remote.name, 'complete'), result);
    assertEquals(f.accepted(), 1);
    server = await f.edge().server();
    const [record] = await server.query(
      "SELECT record_json FROM facade_records WHERE stream LIKE 'ingress:%'",
    );
    const payload = JSON.parse(String(record.record_json))
      .payload as IngressObligation;
    assertEquals(payload.evidence, proof);
    assertEquals(payload.response, result);
    assertEquals(payload.edus, [{
      index: 0,
      disposition: { kind: 'retained' },
    }]);
    assertEquals(
      (await server.query(
        "SELECT count(*) AS n FROM facade_records WHERE stream LIKE 'ingress:%'",
      ))[0].n,
      1,
    );
    const changed = await f.evidence('complete', [], [{
      edu_type: 'changed',
      content: {},
    }]);
    assertEquals(
      (await assertRejects(() => box.stage('complete', changed), MatrixError))
        .status,
      400,
    );
    assertEquals(f.accepted(), 1);
    assertEquals(
      (await server.query(
        'SELECT count(*) AS n FROM facade_ingress_collisions',
      ))[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox recovers a room commit before its child checkpoint without losing or repeating the EDU tail', async () => {
  const f = await fixture();
  try {
    const join = await f.join();
    const box = await f.mailbox();
    await box.stage('room-cut', await f.evidence('room-cut', [join]));
    f.fail((sql, args) =>
      sql.startsWith('INSERT INTO facade_ingress_children') &&
      args[2] === 'room'
    );
    await assertRejects(
      () => box.receive(f.remote.name, 'room-cut'),
      MatrixError,
    );
    const room = await openRoom(f.edge(), f.g.roomId);
    const head = await room.tx((tx) => tx.changes.head());
    assertEquals(
      (await room.tx((tx) => tx.events.getStatus(String(join.event_id))))
        ?.grounding,
      'grounded',
    );
    assertEquals(
      f.accepted(),
      1,
      'a room checkpoint fault must not suppress reliable EDU acceptance',
    );
    await f.reopen();
    const final = await (await f.mailbox()).receive(f.remote.name, 'room-cut');
    assertEquals(final.body, { pdus: { [String(join.event_id)]: {} } });
    const recovered = await openRoom(f.edge(), f.g.roomId);
    assertEquals(await recovered.tx((tx) => tx.changes.head()), head);
    assertEquals(f.accepted(), 1);
    const [record] = await (await f.edge().server()).query(
      "SELECT record_json FROM facade_records WHERE stream LIKE 'ingress:%'",
    );
    const payload = JSON.parse(String(record.record_json))
      .payload as IngressObligation;
    assert(
      payload.rooms[0].recovery.events.some((event) =>
        event.event_id === join.event_id
      ),
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox scope misses retain the independent EDU tail and never cache unknown-room success', async () => {
  const f = await fixture();
  try {
    const box = await f.mailbox();
    const join = await f.join();
    await box.stage('scope-cut', await f.evidence('scope-cut', [join]));
    f.block(true);
    assertEquals(
      (await assertRejects(
        () => box.receive(f.remote.name, 'scope-cut'),
        MatrixError,
      )).status,
      503,
    );
    assertEquals(f.accepted(), 1);
    assertEquals(
      (await (await f.edge().server()).query(
        'SELECT response_json FROM facade_ingress',
      ))[0].response_json,
      null,
    );
    f.block(false);
    assertEquals((await box.receive(f.remote.name, 'scope-cut')).body, {
      pdus: { [String(join.event_id)]: {} },
    });
    assertEquals(f.accepted(), 1);
  } finally {
    await f.close();
  }
});

Deno.test('mailbox configured capacity refuses only new work and journal ACK releases admission accounting without eviction', async () => {
  const f = await fixture();
  try {
    const box = await f.mailbox();
    const proof = await f.evidence('capacity');
    f.fail((sql) => sql.startsWith('INSERT INTO facade_ingress('));
    assertEquals(
      (await assertRejects(() => box.stage('capacity', proof), MatrixError))
        .status,
      503,
    );
    assertEquals(
      await (await f.edge().server()).query('SELECT * FROM facade_ingress'),
      [],
    );
    setConfigForTests({ facade: { mailboxmaxbytes: 1 } });
    assertEquals(
      (await assertRejects(() => box.stage('capacity', proof), MatrixError))
        .status,
      429,
    );
    setConfigForTests({ facade: { mailboxmaxbytes: 0 } });
    await box.stage('capacity', proof);
    const concurrent = await Promise.all([
      box.receive(f.remote.name, 'capacity'),
      box.receive(f.remote.name, 'capacity'),
    ]);
    assertEquals(concurrent[0], concurrent[1]);
    assertEquals(f.accepted(), 1);
    setConfigForTests({ facade: { mailboxmaxbytes: 1 } });
    await box.stage('capacity', proof);
    const server = await f.edge().server();
    const next = await f.evidence('capacity-next');
    setConfigForTests({
      facade: {
        mailboxmaxbytes: Math.max(
          Number(
            (await server.query('SELECT bytes FROM facade_ingress'))[0].bytes,
          ),
          new TextEncoder().encode(canonicalJson(next)).byteLength,
        ),
      },
    });
    assertEquals(
      (await assertRejects(() => box.stage('capacity-next', next), MatrixError))
        .status,
      429,
    );
    const journal = new Journal(server, LINK_CAPABILITIES);
    const [stream] = await journal.streams('home', 'out');
    const record = (await journal.page('home', 'out', stream, 0, {
      maxItems: 1,
      maxBytes: 1,
    })).records[0];
    const cut = { sequence: record.sequence, hash: record.hash };
    await journal.ack('home', stream, cut, cut, [{
      ...cut,
      result: { accepted: true },
    }]);
    await box.stage('capacity-next', next);
    assertEquals(
      (await server.query('SELECT count(*) AS n FROM facade_ingress'))[0].n,
      2,
    );
    assertEquals(
      (await server.query('SELECT count(*) AS n FROM facade_records'))[0].n,
      1,
    );
  } finally {
    await f.close();
  }
});

Deno.test('mailbox schema upgrades the previous server version without recreating identity or pairing', async () => {
  const f = await fixture();
  try {
    const server = await f.edge().server();
    await server.tx(async (conn) => {
      await conn.exec(
        'DROP TABLE facade_ingress_collisions; DROP TABLE facade_ingress_children; DROP TABLE facade_ingress',
      );
      await conn.execute("UPDATE meta SET v=? WHERE k='schema_version'", [
        String(serverSchema.version - 1),
      ]);
    }, { mode: 'deferred' });
    await f.reopen();
    const box = await f.mailbox();
    await box.stage('upgraded', await f.evidence('upgraded'));
    assertEquals((await box.receive(f.remote.name, 'upgraded')).status, 200);
    assertEquals(
      (await (await f.edge().server()).query(
        "SELECT v FROM meta WHERE k='schema_version'",
      ))[0].v,
      String(serverSchema.version),
    );
  } finally {
    await f.close();
  }
});
