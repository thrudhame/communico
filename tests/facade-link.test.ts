import { assertEquals, assertRejects } from '@std/assert';
import { initializeNode } from '#engine/facade/identity.ts';
import { enrollLink, linkHandler } from '#engine/facade/link.ts';
import { Journal } from '#engine/facade/journal.ts';
import { NoticeHub, sseMessages } from '#engine/facade/notices.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  EMPTY_CUT,
  LINK_CAPABILITIES,
  LINK_VERSION,
  LinkError,
  recordHash,
} from '#engine/facade/protocol.ts';
import { LinkClient, startLinkTransport } from '#engine/facade/transport.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { facadeTls } from './support/facade-tls.ts';

Deno.test('polling notices expose only authenticated stream heads', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const response = await f.client().fetch('/_communico/link/v1/notices', {
      headers: {
        'x-communico-link': JSON.stringify({
          protocol: LINK_VERSION,
          server: bundle.server,
          required: LINK_CAPABILITIES,
          source: 'home',
          incarnation: bundle.id,
          pairing: bundle.id,
        }),
      },
    });
    assertEquals(response.status, 200);
    const body = await response.json();
    assertEquals(body.heads, []);
  } finally {
    await f.close();
  }
});

Deno.test('authenticated HTTP journal exchanges durable records and exact results in both directions', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const facadeIncarnation =
      (await f.fp.active()).body.transcript.body.incarnation;
    const envelope = {
      protocol: LINK_VERSION,
      server: bundle.server,
      required: LINK_CAPABILITIES,
      source: 'home',
      incarnation: bundle.id,
      pairing: bundle.id,
    };
    const call = async (route: string, fields?: Record<string, unknown>) => {
      const response = await f.client().fetch(
        '/_communico/link/v1/' + route,
        fields
          ? {
            method: 'POST',
            body: JSON.stringify({ ...envelope, ...fields }),
          }
          : { headers: { 'x-communico-link': JSON.stringify(envelope) } },
      );
      const body = await response.json();
      assertEquals(response.status, 200, JSON.stringify(body));
      assertEquals(body.source, 'edge_a');
      assertEquals(body.incarnation, facadeIncarnation);
      return body;
    };
    const stream = {
      source: 'home',
      incarnation: bundle.id,
      stream: 'control',
    };
    const one = await f.hj.append('edge_a', {
      ...stream,
      type: 'control',
      version: 1,
      operationId: 'one',
      payload: { roster: [] },
    });
    const oneCut = { sequence: one.sequence, hash: one.hash };
    assertEquals((await call('hello')).incoming, []);
    for (
      const patch of [
        { protocol: { major: 2, minor: 0 } },
        { source: 'edge_a' },
        { incarnation: 'different-enrollment' },
      ]
    ) {
      const rejected = await f.client().fetch('/_communico/link/v1/records', {
        method: 'POST',
        body: JSON.stringify({
          ...envelope,
          ...patch,
          stream,
          records: [one],
          after: EMPTY_CUT,
        }),
      });
      assertEquals(rejected.status, 'protocol' in patch ? 409 : 403);
      await rejected.body?.cancel();
      assertEquals(
        (await f.fj.heads('home', 'in', stream)).received,
        EMPTY_CUT,
      );
    }
    const { hash: _hash, ...unsigned } = one;
    const substituted = { ...unsigned, incarnation: 'another-store' };
    const forged = await f.client().fetch('/_communico/link/v1/records', {
      method: 'POST',
      body: JSON.stringify({
        ...envelope,
        stream,
        records: [{ ...substituted, hash: recordHash(substituted) }],
        after: EMPTY_CUT,
      }),
    });
    assertEquals(forged.status, 403);
    await forged.body?.cancel();
    assertEquals((await f.fj.heads('home', 'in', stream)).received, EMPTY_CUT);
    const invalid = await f.client().fetch('/_communico/link/v1/records', {
      method: 'POST',
      body: JSON.stringify({
        ...envelope,
        stream,
        records: [one],
        after: oneCut,
      }),
    });
    assertEquals(invalid.status, 409);
    await invalid.body?.cancel();
    assertEquals((await f.fj.heads('home', 'in', stream)).received, EMPTY_CUT);
    const received = await call('records', {
      stream,
      records: [one],
      after: EMPTY_CUT,
    });
    assertEquals(received.ack, {
      received: oneCut,
      applied: EMPTY_CUT,
      results: [],
    });
    await f.fj.complete('home', stream, oneCut, {
      exact: 'home operation terminal result',
    });
    await f.reopen();
    const completed = await call('records', {
      stream,
      records: [],
      after: EMPTY_CUT,
    });
    await f.hj.ack(
      'edge_a',
      stream,
      completed.ack.received,
      completed.ack.applied,
      completed.ack.results,
    );
    assertEquals(await f.hj.result('edge_a', 'out', stream, oneCut), {
      result: { exact: 'home operation terminal result' },
    });

    const reverse = {
      source: 'edge_a',
      incarnation: facadeIncarnation,
      stream: 'ingress:remote.test',
    };
    const two = await f.fj.append('home', {
      ...reverse,
      type: 'control',
      version: 1,
      operationId: 'two',
      payload: { durable: true },
    });
    const twoCut = { sequence: two.sequence, hash: two.hash };
    assertEquals((await call('hello')).outgoing, [{
      ...reverse,
      received: twoCut,
      applied: EMPTY_CUT,
    }]);
    const pulled = await call(
      'records?stream=' + encodeURIComponent(JSON.stringify(reverse)) +
        '&after=0',
    );
    assertEquals(pulled.page.records, [two]);
    await f.hj.receive('edge_a', pulled.page.records);
    await f.hj.complete('edge_a', reverse, twoCut, { pdus: {} });
    const ack = await f.hj.acknowledgement('edge_a', reverse, EMPTY_CUT, {
      maxItems: 100,
      maxBytes: 10000,
    });
    await call('ack', { stream: reverse, ...ack });
    await f.reopen();
    assertEquals(await f.fj.result('home', 'out', reverse, twoCut), {
      result: { pdus: {} },
    });
    assertEquals(await f.fj.acknowledged('home', reverse), {
      received: twoCut,
      applied: twoCut,
    });
    await f.hp.revoke(bundle.id);
    await enrollLink(f.hp, bundle.id, f.tls.home);
    const denied = await f.client().fetch('/_communico/link/v1/hello', {
      headers: { 'x-communico-link': JSON.stringify(envelope) },
    });
    assertEquals(denied.status, 403);
    await denied.body?.cancel();
  } finally {
    await f.close();
  }
});

async function fixture() {
  const tls = await facadeTls();
  const open = (side: string) =>
    openStore({
      dir: tls.dir + '/' + side,
      library: './.native/libturso_ffi.so',
      checkpointlogbytes: 65536,
      maxopenfiles: 8,
      idleseconds: 300,
    }, { schemas: { server: serverSchema, tenant: tenantSchema } });
  let home = await open('home');
  let facade = await open('facade');
  let tenant = await openTenant(home, 'logical.test', { create: true });
  let node = await initializeNode(
    await facade.server(),
    'logical.test',
    'edge_a',
  );
  let hp = new Pairings(
    await home.server(),
    tenant.signer(),
    tenant.publicB64,
    tls.homePin,
  );
  let fp = new Pairings(
    await facade.server(),
    node.signer(),
    node.publicKey,
    tls.facadePin,
    node,
  );
  let dropReceipt = false;
  let hj = new Journal(await home.server(), LINK_CAPABILITIES);
  let fj = new Journal(await facade.server(), LINK_CAPABILITIES);
  let changes = 0;
  const notices = new NoticeHub();
  const handler = () =>
    linkHandler({
      server: 'logical.test',
      node: node.node,
      incarnation: node.incarnation,
      journal: fj,
      limits: { maxItems: 100, maxBytes: 10000 },
      notices,
      pairings: () => Promise.resolve(fp),
      changed: () => {
        changes++;
        notices.changed();
        return Promise.resolve();
      },
    });
  const transport = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: tls.facade,
    authorize: (pin) => fp.allowsHome(pin),
    handle: async (request, pin) => {
      const response = await handler()(request, pin);
      if (dropReceipt && request.url.endsWith('/complete')) {
        dropReceipt = false;
        throw new Error('receipt response lost after durable completion');
      }
      return response;
    },
  });
  return {
    tls,
    notices,
    get hj() {
      return hj;
    },
    get fj() {
      return fj;
    },
    get hp() {
      return hp;
    },
    get fp() {
      return fp;
    },
    get changes() {
      return changes;
    },
    dropReceipt() {
      dropReceipt = true;
    },
    create: () =>
      hp.create({
        node: 'edge_a',
        url: transport.url,
        facadePin: tls.facadePin,
        expires: Date.now() + 60000,
        required: [...LINK_CAPABILITIES],
      }),
    client: () =>
      new LinkClient(tls.home, { url: transport.url, pin: tls.facadePin }),
    async reopen() {
      await home.close();
      await facade.close();
      home = await open('home');
      facade = await open('facade');
      tenant = await openTenant(home, 'logical.test');
      node = await initializeNode(
        await facade.server(),
        'logical.test',
        'edge_a',
      );
      hp = new Pairings(
        await home.server(),
        tenant.signer(),
        tenant.publicB64,
        tls.homePin,
      );
      fp = new Pairings(
        await facade.server(),
        node.signer(),
        node.publicKey,
        tls.facadePin,
        node,
      );
      hj = new Journal(await home.server(), LINK_CAPABILITIES);
      fj = new Journal(await facade.server(), LINK_CAPABILITIES);
    },
    async close() {
      await transport.close();
      await home.close();
      await facade.close();
      await tls.close();
    },
  };
}

Deno.test('home initiates enrollment over pinned mTLS and retries a lost receipt without plaintext credentials', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    assertEquals(await f.fp.allowsHome(f.tls.homePin), false);
    await f.fp.accept(bundle);
    f.dropReceipt();
    await assertRejects(
      () => enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret),
      LinkError,
    );
    const granted = await f.fp.active();
    assertEquals((await f.hp.status())[0].state, 'granting');
    await f.reopen();
    await enrollLink(f.hp, bundle.id, f.tls.home);
    assertEquals((await f.hp.status())[0].state, 'paired');
    assertEquals(await f.fp.active(), granted);
    await enrollLink(f.hp, bundle.id, f.tls.home);
    assertEquals(await f.fp.active(), granted);
    assertEquals(f.changes, 3);
    await f.hp.revoke(bundle.id);
    await enrollLink(f.hp, bundle.id, f.tls.home);
    await f.reopen();
    await enrollLink(f.hp, bundle.id, f.tls.home);
    await assertRejects(() => f.fp.active(), LinkError, 'not enrolled');
    assertEquals((await f.fp.status())[0].state, 'revoked');
  } finally {
    await f.close();
  }
});

for (const mode of ['websocket', 'sse'] as const) {
  Deno.test(`${mode} notices authenticate before upgrade and carry heads only through revocation`, async () => {
    const f = await fixture();
    const abort = new AbortController();
    try {
      const bundle = await f.create();
      await f.fp.accept(bundle);
      const envelope = {
        protocol: LINK_VERSION,
        server: bundle.server,
        required: LINK_CAPABILITIES,
        source: 'home',
        incarnation: bundle.id,
        pairing: bundle.id,
      };
      const headers = { 'x-communico-link': JSON.stringify(envelope) };
      const connect = async (patch = {}) => {
        const h = { ...headers, ...patch };
        if (mode === 'websocket') {
          return await f.client().websocket('/_communico/link/v1/notices', {
            headers: h,
            signal: abort.signal,
          });
        }
        const response = await f.client().fetch('/_communico/link/v1/notices', {
          headers: { ...h, accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error('notice admission refused');
        }
        return ReadableStream.from(sseMessages(response.body!));
      };
      // An accepted client certificate is not a completed enrollment grant.
      await assertRejects(() => connect());
      await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
      await assertRejects(() =>
        connect({
          'x-communico-link': JSON.stringify({
            ...envelope,
            protocol: { major: 2, minor: 0 },
          }),
        })
      );
      const body = await connect();
      const reader = body.getReader();
      assertEquals(JSON.parse((await reader.read()).value!).heads, []);
      const stream = {
        source: 'edge_a',
        incarnation: (await f.fp.active()).body.transcript.body.incarnation,
        stream: 'ingress:remote.test',
      };
      const record = await f.fj.append('home', {
        ...stream,
        type: 'control',
        version: 1,
        operationId: 'notice',
        payload: { secret: 'this must never enter a notice' },
      });
      f.notices.changed();
      const changed = JSON.parse((await reader.read()).value!);
      assertEquals(changed.heads, [{
        ...stream,
        head: { sequence: record.sequence, hash: record.hash },
      }]);
      assertEquals(JSON.stringify(changed).includes('secret'), false);
      assertEquals(changed.pairing, bundle.id);
      await f.hp.revoke(bundle.id);
      await enrollLink(f.hp, bundle.id, f.tls.home);
      // The existing socket must stop when its grant is retired, not emit a
      // final head under a cached authorization or keep the source store alive.
      const end = await reader.read().catch(() => ({ done: true }));
      assertEquals(end.done, true);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
      await assertRejects(() => connect());
    } finally {
      abort.abort();
      await f.close();
    }
  });
}

Deno.test('enrollment HTTP rejects wrong secrets and protocol skew without granting authority', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await assertRejects(
      () => enrollLink(f.hp, bundle.id, f.tls.home, 'wrong'),
      LinkError,
    );
    await assertRejects(
      () => enrollLink(f.hp, bundle.id, f.tls.home),
      LinkError,
    );
    for (
      const patch of [
        { protocol: { major: 2, minor: 0 } },
        { required: [{ type: 'sql', version: 1 }] },
        { server: 'other.test' },
      ]
    ) {
      const response = await f.client().fetch('/_communico/link/v1/enroll', {
        method: 'POST',
        body: JSON.stringify({
          protocol: LINK_VERSION,
          required: LINK_CAPABILITIES,
          server: 'logical.test',
          source: 'home',
          incarnation: bundle.id,
          pairing: bundle.id,
          secret: bundle.secret,
          ...patch,
        }),
      });
      assertEquals(response.status, patch.server ? 403 : 409);
      await response.body?.cancel();
    }
    assertEquals((await f.hp.status())[0].state, 'pending');
    await assertRejects(() => f.fp.active(), LinkError);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    assertEquals((await f.hp.status())[0].state, 'paired');
  } finally {
    await f.close();
  }
});
