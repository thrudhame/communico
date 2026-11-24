import { assert, assertEquals, assertRejects } from '@std/assert';
import { exportKeyRoster, FacadeKeys } from '#engine/facade/control.ts';
import { homeKeyDocument } from '#engine/federation/keydoc.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  importPublicKeyFromRaw,
  matrixBase64,
  verifyJson,
} from '#engine/signing-primitives.js';
import { enrolledTenant, initializeNode } from '#engine/facade/identity.ts';
import { exportOwnerControl, OwnerControls } from '#engine/facade/ownership.ts';
import { JournalClient, openJournalClient } from '#engine/facade/client.ts';
import {
  JournalReconciler,
  startHomeLinkWorker,
  startInboxWorker,
} from '#engine/facade/worker.ts';
import { enrollLink, linkHandler } from '#engine/facade/link.ts';
import { Journal } from '#engine/facade/journal.ts';
import { NoticeHub, sseMessages } from '#engine/facade/notices.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  EMPTY_CUT,
  LINK_CAPABILITIES,
  LINK_SUPPORTED,
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

Deno.test('journal result polling is read-only and does not echo another reconciliation notice', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const stream = {
      source: 'home',
      incarnation: bundle.id,
      stream: 'control',
    };
    const before = f.changes;
    const initial = await client.push(stream, [], EMPTY_CUT);
    assertEquals(initial.received, EMPTY_CUT);
    assertEquals(f.changes, before);
    const record = await f.hj.append('edge_a', {
      ...stream,
      type: 'control',
      version: 1,
      operationId: 'notice-boundary',
      payload: { revision: 1 },
    });
    const cut = { sequence: record.sequence, hash: record.hash };
    await client.push(stream, [record], EMPTY_CUT);
    assertEquals(f.changes, before + 1);
    await f.fj.complete('home', stream, cut, { applied: true });
    const ready = await client.push(stream, [], EMPTY_CUT);
    assertEquals(ready.applied, cut);
    assertEquals(ready.results.length, 1);
    assertEquals(f.changes, before + 1);
    // A lost receipt may replay a nonempty page and still wake its apply owner.
    await client.push(stream, [record], cut);
    assertEquals(f.changes, before + 2);
    await client.push(stream, [], cut);
    assertEquals(f.changes, before + 2);
  } finally {
    await f.close();
  }
});

async function fixture(
  supported = LINK_CAPABILITIES,
  activityOptions: {
    activity?: {
      capture(pairing: string): Promise<unknown>;
      apply(
        pairing: string,
        snapshot: unknown,
        elapsed: () => number,
      ): Promise<void>;
    };
  } = {},
) {
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
  let hj = new Journal(await home.server(), supported);
  let fj = new Journal(await facade.server(), supported);
  let changes = 0;
  const notices = new NoticeHub();
  const handler = () =>
    linkHandler({
      ...activityOptions,
      server: 'logical.test',
      node: node.node,
      incarnation: node.incarnation,
      journal: fj,
      limits: { maxItems: 100, maxBytes: 10000 },
      notices,
      pairings: () => Promise.resolve(fp),
      signKeyDocument: async (raw) =>
        await new FacadeKeys(
          await facade.server(),
          node.signer(),
          node.publicKey,
          fp,
        ).cosign(raw),
      changed: () => {
        changes++;
        notices.changed();
        return Promise.resolve();
      },
    });
  let handle = handler();
  const transport = await startLinkTransport({
    hostname: '127.0.0.1',
    port: 0,
    tls: tls.facade,
    authorize: (pin) => fp.allowsHome(pin),
    handle: async (request, pin) => {
      const response = await handle(request, pin);
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
    home: () => home,
    tenant: () => tenant,
    ownership: async () => {
      await enrolledTenant(facade, fp, 'logical.test', 'edge_a');
      return new OwnerControls(
        await facade.server(),
        await facade.tenant('logical.test'),
        fp,
        node,
      );
    },
    keys: async () =>
      new FacadeKeys(await facade.server(), node.signer(), node.publicKey, fp),
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
    restartLink() {
      handle = handler();
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
      hj = new Journal(await home.server(), supported);
      fj = new Journal(await facade.server(), supported);
      handle = handler();
    },
    async close() {
      await transport.close();
      await home.close();
      await facade.close();
      await tls.close();
    },
  };
}

Deno.test('live link: receiver challenge ages delayed answers, is single-use and is lost on restart', async () => {
  let now = 1_000;
  const clock = performance.now;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now,
  });
  const applied: { pairing: string; snapshot: unknown; age: number }[] = [];
  const f = await fixture(LINK_SUPPORTED, {
    activity: {
      capture: () => Promise.resolve({ remainingMs: 30_000 }),
      apply: (pairing, snapshot, elapsed) => {
        applied.push({ pairing, snapshot, age: elapsed() });
        return Promise.resolve();
      },
    },
  });
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const envelope = {
      protocol: LINK_VERSION,
      server: bundle.server,
      required: [...LINK_CAPABILITIES, { type: 'live-activity', version: 1 }],
      source: 'home',
      incarnation: bundle.id,
      pairing: bundle.id,
    };
    const call = async (challenge: string, answer?: unknown) => {
      const response = await f.client().fetch('/_communico/link/v1/activity', {
        method: 'POST',
        body: JSON.stringify({ ...envelope, challenge, answer }),
      });
      assertEquals(response.status, 200);
      return await response.json();
    };
    const first = await call('home-1');
    assertEquals(first.challenge, 'home-1');
    assertEquals(first.snapshot, { remainingMs: 30_000 });
    assertEquals(applied, []);
    now += 40_000;
    const answer = {
      challenge: first.nextChallenge,
      snapshot: { remainingMs: 30_000 },
    };
    const second = await call('home-2', answer);
    assertEquals(applied, [{
      pairing: bundle.id,
      snapshot: { remainingMs: 30_000 },
      age: 40_000,
    }]);
    await call('home-3', answer);
    assertEquals(applied.length, 1, 'replay must not import activity again');
    f.restartLink();
    await call('home-4', {
      challenge: second.nextChallenge,
      snapshot: { remainingMs: 30_000 },
    });
    assertEquals(
      applied.length,
      1,
      'restart cannot retain a freshness challenge',
    );
    assertEquals(await f.fj.streams('home', 'in'), []);
    assertEquals(await f.fj.streams('home', 'out'), []);
  } finally {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: clock,
    });
    await f.close();
  }
});

Deno.test('live link: capability and active pairing are checked before activity callbacks', async () => {
  let captured = 0;
  const f = await fixture(LINK_SUPPORTED, {
    activity: {
      capture: () => {
        captured++;
        return Promise.resolve({});
      },
      apply: () => Promise.resolve(),
    },
  });
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    for (
      const [patch, expected] of [
        [{ required: LINK_CAPABILITIES }, 409],
        [{ incarnation: 'another-pairing' }, 403],
        [{ source: 'edge_a' }, 403],
      ] as const
    ) {
      const response = await f.client().fetch('/_communico/link/v1/activity', {
        method: 'POST',
        body: JSON.stringify({
          protocol: LINK_VERSION,
          server: bundle.server,
          required: [...LINK_CAPABILITIES, {
            type: 'live-activity',
            version: 1,
          }],
          source: 'home',
          incarnation: bundle.id,
          pairing: bundle.id,
          challenge: 'home-1',
          ...patch,
        }),
      });
      assertEquals(response.status, expected);
      await response.body?.cancel();
      assertEquals(captured, 0);
    }
  } finally {
    await f.close();
  }
});

Deno.test('live link: home pull subtracts its own round trip and answers only a facade challenge', async () => {
  let now = 1_000;
  const clock = performance.now;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now,
  });
  const facadeAges: number[] = [], homeAges: number[] = [];
  const f = await fixture(LINK_SUPPORTED, {
    activity: {
      capture: () => {
        now += 40_000;
        return Promise.resolve({ remainingMs: 30_000 });
      },
      apply: (_pairing, snapshot, elapsed) => {
        assertEquals(snapshot, { from: 'home' });
        facadeAges.push(elapsed());
        return Promise.resolve();
      },
    },
  });
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    let captures = 0;
    const activity = {
      capture: () => {
        captures++;
        now += 5_000;
        return Promise.resolve({ from: 'home' });
      },
      apply: (_pairing: string, snapshot: unknown, elapsed: () => number) => {
        assertEquals(snapshot, { remainingMs: 30_000 });
        // The transport's receiver clock includes time waiting inside the owner.
        now += 1_000;
        homeAges.push(elapsed());
        return Promise.resolve();
      },
    };
    await client.activity(activity);
    assertEquals(
      captures,
      1,
      'answer the receiver challenge within the exchange',
    );
    assertEquals(homeAges, [46_000]);
    assertEquals(facadeAges, [6_000]);
    now += 2_000;
    await client.activity(activity);
    assertEquals(captures, 2);
    assertEquals(facadeAges, [6_000, 6_000]);
    assertEquals(homeAges, [46_000, 46_000]);
    f.restartLink();
    await client.activity(activity);
    assertEquals(facadeAges.length, 3, 'a fresh challenge works after restart');
  } finally {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: clock,
    });
    await f.close();
  }
});

Deno.test('live link: unrelated idle time never expires a fresh home snapshot', async () => {
  let now = 1_000;
  const clock = performance.now;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now,
  });
  let visible = false;
  const f = await fixture(LINK_SUPPORTED, {
    activity: {
      capture: () => Promise.resolve({}),
      apply: (_pairing, snapshot, elapsed) => {
        visible =
          elapsed() < Number((snapshot as { remainingMs: number }).remainingMs);
        return Promise.resolve();
      },
    },
  });
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    let remainingMs = 0;
    const owner = {
      capture: () => Promise.resolve({ remainingMs }),
      apply: () => Promise.resolve(),
    };
    await client.activity(owner);
    assertEquals(visible, false);
    now += 60_000;
    remainingMs = 30_000;
    await client.activity(owner);
    assertEquals(visible, true, 'fresh snapshot after an idle period');
  } finally {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: clock,
    });
    await f.close();
  }
});

Deno.test('live link: client refuses substituted, unnegotiated and superseded answers', async () => {
  const f = await fixture(LINK_SUPPORTED);
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const peer = (await openJournalClient(f.hp, bundle.id, f.tls.home)).peer;
    const wire = f.client();
    let mode = 'old';
    let applied = 0;
    const pending: { answer: Response; resolve(value: Response): void }[] = [];
    wire.fetch = (_path, init) => {
      const request = JSON.parse(String(init?.body));
      const answer = Response.json({
        protocol: LINK_VERSION,
        server: peer.server,
        source: mode === 'identity' ? 'another-node' : peer.node,
        incarnation: peer.incarnation,
        pairing: peer.pairing,
        required: mode === 'old'
          ? LINK_CAPABILITIES
          : [...LINK_CAPABILITIES, { type: 'live-activity', version: 1 }],
        challenge: mode === 'challenge' ? 'substituted' : request.challenge,
        nextChallenge: crypto.randomUUID(),
        snapshot: {},
      });
      if (mode !== 'held' || request.finish === true) {
        return Promise.resolve(answer);
      }
      const wait = Promise.withResolvers<Response>();
      pending.push({ answer, resolve: wait.resolve });
      return wait.promise;
    };
    const client = new JournalClient(wire, peer, () => Promise.resolve());
    const activity = {
      capture: () => Promise.resolve({}),
      apply: () => {
        applied++;
        return Promise.resolve();
      },
    };
    for (mode of ['old', 'identity', 'challenge']) {
      await assertRejects(() => client.activity(activity), LinkError);
      assertEquals(applied, 0);
    }
    mode = 'held';
    const first = client.activity(activity);
    const second = client.activity(activity);
    // Both calls enter their async authorization before reaching the wire.
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(pending.length, 2);
    pending[1].resolve(pending[1].answer);
    await second;
    assertEquals(applied, 1);
    pending[0].resolve(pending[0].answer);
    await first;
    assertEquals(
      applied,
      1,
      'old in-flight answer cannot replace a newer pull',
    );
    await assertRejects(async () => {
      const revoked = new JournalClient(wire, peer, () => {
        throw new LinkError('LINK_UNPAIRED', 'revoked', 403);
      });
      await revoked.activity(activity);
    }, LinkError);
    assertEquals(applied, 1);
  } finally {
    await f.close();
  }
});

Deno.test('live link: existing worker serializes pulls, preserves a wake and keeps hello read-only', async () => {
  const f = await fixture(LINK_SUPPORTED);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const successor = Promise.withResolvers<void>();
  let worker: ReturnType<typeof startHomeLinkWorker> | undefined;
  let pulls = 0, active = 0, maximum = 0;
  const failures: unknown[] = [];
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    client.activity = async () => {
      pulls++;
      maximum = Math.max(maximum, ++active);
      if (pulls === 1) {
        entered.resolve();
        await release.promise;
      } else successor.resolve();
      active--;
    };
    worker = startHomeLinkWorker({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      notify: 'poll',
      pollseconds: 60,
      reconnectmaxseconds: 60,
      failed: (error) => failures.push(error),
      apply: () => Promise.resolve(false),
      activity: {
        capture: () => Promise.resolve({}),
        apply: () => Promise.resolve(),
      },
    });
    await testDeadline(entered.promise);
    await client.hello();
    assertEquals(pulls, 1);
    worker.wake();
    worker.wake();
    assertEquals(pulls, 1);
    release.resolve();
    await testDeadline(successor.promise);
    await worker.close();
    assertEquals(pulls, 2);
    assertEquals(maximum, 1);
    assertEquals(failures, []);
  } finally {
    release.resolve();
    await worker?.close();
    await f.close();
  }
});

Deno.test('live link: applied authority re-drives pending activity without a notice or poll', async (t) => {
  for (const direction of ['in', 'out'] as const) {
    await t.step(direction, async () => {
      const f = await fixture(LINK_SUPPORTED);
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const pending = Promise.withResolvers<void>();
      const delivered = Promise.withResolvers<void>();
      const failures: unknown[] = [];
      let worker: ReturnType<typeof startHomeLinkWorker> | undefined;
      try {
        const bundle = await f.create();
        await f.fp.accept(bundle);
        await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
        const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
        const stream = direction === 'in'
          ? {
            source: 'edge_a',
            incarnation: client.peer.incarnation,
            stream: 'authority:@alice:logical.test',
          }
          : {
            source: 'home',
            incarnation: bundle.id,
            stream: 'auth:@alice:logical.test',
          };
        const record = await (direction === 'in' ? f.fj : f.hj).append(
          direction === 'in' ? 'home' : 'edge_a',
          {
            ...stream,
            type: 'control',
            version: 1,
            operationId: 'held-authority',
            payload: {},
          },
        );
        const push = client.push.bind(client);
        client.push = async (...args) => {
          await push(...args); // Durable receipt is not application.
          entered.resolve();
          await release.promise;
          await f.fj.complete('home', stream, record, {});
          return await push(...args);
        };
        client.activity = async () => {
          const heads = direction === 'in'
            ? await f.hj.heads('edge_a', 'in', stream)
            : await f.hj.acknowledged('edge_a', stream);
          if (heads.applied.sequence !== record.sequence) {
            pending.resolve();
            throw new LinkError(
              'LINK_UNAVAILABLE',
              'live activity awaits applied authority',
              503,
            );
          }
          delivered.resolve();
        };
        worker = startHomeLinkWorker({
          client,
          journal: f.hj,
          limits: { maxItems: 1, maxBytes: 1000 },
          notify: 'poll',
          pollseconds: 60,
          reconnectmaxseconds: 60,
          failed: (error) => failures.push(error),
          apply: async (source) => {
            const next = await f.hj.next('edge_a', source);
            if (!next) return false;
            entered.resolve();
            await release.promise;
            await f.hj.complete('edge_a', source, next, {});
            return true;
          },
          activity: {
            capture: () => Promise.resolve({}),
            apply: () => Promise.resolve(),
          },
        });
        await testDeadline(Promise.all([entered.promise, pending.promise]));
        assert(
          failures.every((error) =>
            error instanceof LinkError && error.code === 'LINK_UNAVAILABLE'
          ),
        );
        release.resolve(); // No explicit wake, notice, reconnect or periodic tick.
        await testDeadline(delivered.promise);
      } finally {
        release.resolve();
        await worker?.close();
        await f.close();
      }
    });
  }
});

Deno.test('live link: a ready wake exchanges before admitting a newer authority tail', async () => {
  const f = await fixture(LINK_SUPPORTED);
  const observed = Promise.withResolvers<boolean>();
  let worker: ReturnType<typeof startHomeLinkWorker> | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const stream = {
      source: 'edge_a',
      incarnation: client.peer.incarnation,
      stream: 'authority:@alice:logical.test',
    };
    const append = (id: string) =>
      f.fj.append('home', {
        ...stream,
        type: 'control',
        version: 1,
        operationId: id,
        payload: {},
      });
    const applied = await append('applied-authority');
    await f.hj.receive('edge_a', [applied]);
    await f.hj.complete('edge_a', stream, applied, {});
    const future = await append('future-authority');
    const hello = client.hello.bind(client);
    client.hello = async (signal) => {
      // Reconciliation can receive a fresh auth declaration on every wake. It
      // must not invalidate the applied cut before the pending live attempt.
      await f.hj.receive('edge_a', [future]);
      return await hello(signal);
    };
    client.activity = async () => {
      const heads = await f.hj.heads('edge_a', 'in', stream);
      observed.resolve(heads.received.sequence === heads.applied.sequence);
    };
    worker = startHomeLinkWorker({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      notify: 'poll',
      pollseconds: 60,
      reconnectmaxseconds: 60,
      failed: () => {},
      apply: () => Promise.resolve(false),
      activity: {
        capture: () => Promise.resolve({}),
        apply: () => Promise.resolve(),
      },
    });
    assertEquals(await testDeadline(observed.promise), true);
  } finally {
    await worker?.close();
    await f.close();
  }
});

Deno.test('live link: a stalled activity exchange does not hold journal reconciliation', async () => {
  const f = await fixture(LINK_SUPPORTED);
  const delivered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let worker: ReturnType<typeof startHomeLinkWorker> | undefined;
  let active = 0;
  let expired = false;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const stream = {
      source: 'edge_a',
      incarnation: client.peer.incarnation,
      stream: 'activity-independent',
    };
    const record = await f.fj.append('home', {
      ...stream,
      type: 'control',
      version: 1,
      operationId: 'while-activity-stalled',
      payload: {},
    });
    client.activity = async (_owner, signal) => {
      assertEquals(++active, 1);
      let abort: (() => void) | undefined;
      try {
        await Promise.race([
          release.promise,
          new Promise<never>((_, reject) => {
            abort = () => reject(signal?.reason);
            signal?.addEventListener('abort', abort, { once: true });
          }),
        ]);
      } catch (error) {
        if (
          signal?.reason instanceof DOMException &&
          signal.reason.name === 'TimeoutError'
        ) expired = true;
        throw error;
      } finally {
        if (abort) signal?.removeEventListener('abort', abort);
        active--;
      }
    };
    worker = startHomeLinkWorker({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      notify: 'poll',
      pollseconds: 60,
      reconnectmaxseconds: 60,
      failed: () => {},
      apply: async (stream) => {
        const next = await f.hj.next('edge_a', stream);
        if (!next) return false;
        await f.hj.complete('edge_a', stream, next, {});
        delivered.resolve();
        return true;
      },
      activity: {
        capture: () => Promise.resolve({}),
        apply: () => Promise.resolve(),
      },
    });
    await testDeadline(delivered.promise);
    assert(expired);
    assertEquals(
      (await f.hj.heads('edge_a', 'in', stream)).applied.hash,
      record.hash,
    );
  } finally {
    release.resolve();
    await worker?.close();
    await f.close();
  }
});

Deno.test('F1 enrollment upgrades ownership over the same authenticated link, with apply ACK after both files', async () => {
  const f = await fixture(LINK_SUPPORTED);
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const record = await exportOwnerControl(
      f.home(),
      f.tenant(),
      f.hp,
      bundle.id,
    );
    const response = await client.push(record, [record], EMPTY_CUT);
    assertEquals(response.received.sequence, 1);
    assertEquals(response.applied.sequence, 0);
    const owner = await f.ownership();
    await owner.apply(f.fj, record);
    const ready = await owner.ready();
    assertEquals(ready.policy, 'first-ingress');
    const next = await client.push(record, [record], EMPTY_CUT);
    assertEquals(next.applied.sequence, 1);
    assertEquals(next.results.length, 1);
    await f.reopen();
    assertEquals(await (await f.ownership()).ready(), ready);
  } finally {
    await f.close();
  }
});

Deno.test('co-signed key publication collects over the authenticated link before either public role serves it', async () => {
  const f = await fixture();
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const tenant = f.tenant();
    const homeDoc = async () =>
      await homeKeyDocument(
        await f.home().server(),
        tenant.signer(),
        tenant.publicB64,
      );
    await assertRejects(homeDoc, MatrixError, 'not ready');
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    let calls = 0;
    const record = await exportKeyRoster(
      f.home(),
      tenant,
      'edge_a',
      bundle.id,
      async (_id, doc) => {
        calls++;
        await assertRejects(homeDoc, MatrixError, 'not ready');
        return await client.signKeyDocument(doc);
      },
    );
    assertEquals(calls, 1);
    const document = await homeDoc();
    assertEquals(
      Object.keys(document.signatures[tenant.serverName]).sort(),
      Object.keys(document.verify_keys).sort(),
    );
    for (const [id, key] of Object.entries(document.verify_keys)) {
      assert(
        await verifyJson(
          document,
          tenant.serverName,
          id,
          await importPublicKeyFromRaw(matrixBase64(key.key, 32)),
        ),
      );
    }
    await client.push(record, [record], EMPTY_CUT);
    await (await f.keys()).apply(f.fj, record);
    assertEquals(await (await f.keys()).document(), document);
    const changed = structuredClone(document);
    changed.valid_until_ts--;
    await assertRejects(
      () => client.signKeyDocument(changed),
      LinkError,
      'refused',
    );
    const unsigned = structuredClone(document);
    delete unsigned.signatures[tenant.serverName][tenant.keyId];
    await assertRejects(
      () => client.signKeyDocument(unsigned),
      LinkError,
      'refused',
    );
    await f.reopen();
    assertEquals(await (await f.keys()).document(), document);
    const reopened = await openJournalClient(f.hp, bundle.id, f.tls.home);
    await f.hp.revoke(bundle.id);
    await assertRejects(
      () => reopened.signKeyDocument(document),
      LinkError,
      'no longer active',
    );
  } finally {
    await f.close();
  }
});

Deno.test('re-enrollment exposes only active home streams while retaining retired records', async () => {
  const f = await fixture();
  const failures: unknown[] = [];
  try {
    const first = await f.create();
    await f.fp.accept(first);
    await enrollLink(f.hp, first.id, f.tls.home, first.secret);
    const old = await f.hj.append('edge_a', {
      source: 'home',
      incarnation: first.id,
      stream: 'control',
      type: 'control',
      version: 1,
      operationId: 'retired',
      payload: 1,
    });
    await f.fj.receive('home', [old]);
    await f.hp.revoke(first.id);
    await enrollLink(f.hp, first.id, f.tls.home);
    const second = await f.create();
    await f.fp.accept(second);
    await enrollLink(f.hp, second.id, f.tls.home, second.secret);
    const client = await openJournalClient(f.hp, second.id, f.tls.home);
    assertEquals((await client.hello()).incoming, []);
    assertEquals(await client.poll(), []);
    for (const mode of ['websocket', 'sse'] as const) {
      const abort = new AbortController();
      const notices = client.notices(mode, abort.signal);
      try {
        assertEquals((await notices.next()).value, []);
      } finally {
        abort.abort();
        await notices.return(undefined).catch(() => {});
      }
    }
    const current = await f.hj.append('edge_a', {
      source: 'home',
      incarnation: second.id,
      stream: 'control',
      type: 'control',
      version: 1,
      operationId: 'current',
      payload: 2,
    });
    const reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 100, maxBytes: 10000 },
      apply: () => Promise.resolve(false),
      failed: (error) => failures.push(error),
    });
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(failures, []);
    assertEquals(
      (await f.fj.heads('home', 'in', current)).received.sequence,
      1,
    );
    assertEquals(
      (await f.fj.page('home', 'in', old, 0, {
        maxItems: 100,
        maxBytes: 10000,
      })).records,
      [old],
    );
    assertEquals(
      (await client.hello()).incoming.map((stream) => stream.incarnation),
      [second.id],
    );
  } finally {
    await f.close();
  }
});

Deno.test('durable result is ACKed before a later operation blocks in the same stream', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let reconciler: JournalReconciler | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const stream = {
      source: 'edge_a',
      incarnation: client.peer.incarnation,
      stream: 'ingress:remote.test',
    };
    const records = [];
    for (const i of [1, 2]) {
      records.push(
        await f.fj.append('home', {
          ...stream,
          type: 'control',
          version: 1,
          operationId: 'progress-' + i,
          payload: i,
        }),
      );
    }
    reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      failed: (error) => failures.push(error),
      apply: async (source) => {
        const next = await f.hj.next('edge_a', source);
        if (!next) return false;
        if (next.payload === 2) {
          entered.resolve();
          await release.promise;
        }
        await f.hj.complete('edge_a', source, next, { exact: next.payload });
        return true;
      },
    });
    await reconciler.reconcile();
    await testDeadline(entered.promise);
    assertEquals(await f.fj.result('home', 'out', stream, records[0]), {
      result: { exact: 1 },
    });
    assertEquals(await f.fj.result('home', 'out', stream, records[1]), null);
    release.resolve();
    await reconciler.drain();
    assertEquals(failures, []);
    assertEquals(await f.fj.result('home', 'out', stream, records[1]), {
      result: { exact: 2 },
    });
  } finally {
    release.resolve();
    await reconciler?.drain();
    await f.close();
  }
});

Deno.test('home application completion wakes another blocked incoming stream without another reconciliation', async () => {
  const f = await fixture();
  const blocked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let reconciler: JournalReconciler | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const base = {
      source: 'edge_a',
      incarnation: client.peer.incarnation,
      type: 'control',
      version: 1,
    };
    const dependency = await f.fj.append('home', {
      ...base,
      stream: 'room:z-dependency',
      operationId: 'dependency',
      payload: 1,
    });
    const dependent = await f.fj.append('home', {
      ...base,
      stream: 'room:a-dependent',
      operationId: 'dependent',
      payload: 2,
    });
    reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 100, maxBytes: 10000 },
      failed: (error) => failures.push(error),
      async apply(stream) {
        const next = await f.hj.next('edge_a', stream);
        if (!next) return false;
        if (next.operationId === dependency.operationId) await release.promise;
        if (
          next.operationId === dependent.operationId &&
          await f.hj.result('edge_a', 'in', dependency, dependency) === null
        ) {
          blocked.resolve();
          throw new LinkError(
            'LINK_UNAVAILABLE',
            'dependent domain awaits application',
          );
        }
        await f.hj.complete('edge_a', stream, next, { applied: next.payload });
        if (next.operationId === dependent.operationId) completed.resolve();
        return true;
      },
    });
    await reconciler.reconcile();
    await testDeadline(blocked.promise);
    release.resolve();
    await testDeadline(completed.promise);
    await reconciler.drain();
    assertEquals(failures.length, 1);
    assertEquals(await f.fj.result('home', 'out', dependent, dependent), {
      result: { applied: 2 },
    });
  } finally {
    release.resolve();
    await reconciler?.drain();
    await f.close();
  }
});

Deno.test('durable outgoing ACK progress wakes its consumer without waiting for a fault retry timer', async () => {
  const f = await fixture();
  const notifications: string[] = [];
  const failures: unknown[] = [];
  let reconciler: JournalReconciler | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const record = await f.hj.append('edge_a', {
      source: 'home',
      incarnation: bundle.id,
      stream: 'egress:remote.test',
      type: 'control',
      version: 1,
      operationId: 'ack-wake',
      payload: {},
    });
    await client.push(record, [record], EMPTY_CUT);
    reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 100, maxBytes: 10000 },
      apply: () => Promise.resolve(false),
      failed: (error) => failures.push(error),
      acknowledged: (stream) => notifications.push(stream.stream),
    });
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(notifications, [], 'receipt alone is not an applied result');
    await f.fj.complete('home', record, record, { fence: 'ready' });
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(await f.hj.result('edge_a', 'out', record, record), {
      result: { fence: 'ready' },
    });
    assertEquals(notifications, ['egress:remote.test']);
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(
      notifications,
      ['egress:remote.test'],
      'an unchanged ACK is not progress',
    );
    assertEquals(failures, []);
  } finally {
    await reconciler?.drain();
    await f.close();
  }
});

Deno.test('outgoing progress drains an application completed after the receipt snapshot without a new hello or notice', async () => {
  const f = await fixture();
  const notifications: string[] = [];
  const failures: unknown[] = [];
  let reconciler: JournalReconciler | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const record = await f.hj.append('edge_a', {
      source: 'home',
      incarnation: bundle.id,
      stream: 'egress:remote.test',
      type: 'control',
      version: 1,
      operationId: 'receipt-then-result',
      payload: {},
    });
    const push = client.push.bind(client);
    const pages: number[] = [];
    client.push = async (...args) => {
      const response = await push(...args);
      pages.push(args[1].length);
      if (args[1].length) {
        assertEquals(response.applied, EMPTY_CUT);
        // The receipt response has its own read cut. Application can commit
        // immediately afterwards, without a fresh source mutation or notice.
        await f.fj.complete('home', record, record, { fence: 'ready' });
      }
      return response;
    };
    reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 100, maxBytes: 10000 },
      apply: () => Promise.resolve(false),
      failed: (error) => failures.push(error),
      acknowledged: (stream) => notifications.push(stream.stream),
    });
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(failures, []);
    assertEquals(await f.hj.result('edge_a', 'out', record, record), {
      result: { fence: 'ready' },
    });
    assertEquals(pages, [1, 0]);
    assertEquals(notifications, ['egress:remote.test']);
  } finally {
    await reconciler?.drain();
    await f.close();
  }
});

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

Deno.test('typed reconciliation delivers fair pages and exact results across reopen without notices', async () => {
  const f = await fixture();
  const failures: unknown[] = [];
  const make = async (id: string) =>
    new JournalReconciler({
      client: await openJournalClient(f.hp, id, f.tls.home),
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1 },
      apply: (stream) =>
        f.hj.apply('edge_a', stream, (_conn, record) =>
          Promise.resolve({ accepted: record.payload })),
      failed: (error) =>
        failures.push(error),
    });
  try {
    const bundle = await f.create();
    await assertRejects(
      () => openJournalClient(f.hp, bundle.id, f.tls.home),
      LinkError,
    );
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const homeStream = {
      source: 'home',
      incarnation: bundle.id,
      stream: 'room:one',
    };
    const facadeStream = {
      source: 'edge_a',
      incarnation: (await f.fp.active()).body.transcript.body.incarnation,
      stream: 'ingress:remote.test',
    };
    const forward = [];
    const reverse = [];
    for (let i = 0; i < 3; i++) {
      forward.push(
        await f.hj.append('edge_a', {
          ...homeStream,
          type: 'control',
          version: 1,
          operationId: 'home-' + i,
          payload: { i },
        }),
      );
      reverse.push(
        await f.fj.append('home', {
          ...facadeStream,
          type: 'control',
          version: 1,
          operationId: 'facade-' + i,
          payload: { i },
        }),
      );
    }
    let reconciler = await make(bundle.id);
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(failures, []);
    assertEquals(
      (await f.fj.heads('home', 'in', homeStream)).received.sequence,
      3,
    );
    assertEquals(
      (await f.hj.acknowledged('edge_a', homeStream)).applied,
      EMPTY_CUT,
    );
    for (const record of reverse) {
      assertEquals(await f.fj.result('home', 'out', facadeStream, record), {
        result: { accepted: record.payload },
      });
    }
    while (
      await f.fj.apply(
        'home',
        homeStream,
        (_conn, record) => Promise.resolve({ received: record.payload }),
      )
    ) { /* drain owner work */ }
    await f.reopen();
    reconciler = await make(bundle.id);
    await reconciler.reconcile();
    await reconciler.drain();
    assertEquals(failures, []);
    assertEquals(
      (await f.hj.acknowledged('edge_a', homeStream)).applied.sequence,
      3,
    );
    for (const record of forward) {
      assertEquals(await f.hj.result('edge_a', 'out', homeStream, record), {
        result: { received: record.payload },
      });
    }
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    assertEquals((await client.poll()).length, 2);
    await f.hp.revoke(bundle.id);
    await assertRejects(() => client.hello(), LinkError);
    await assertRejects(
      () => openJournalClient(f.hp, bundle.id, f.tls.home),
      LinkError,
    );
  } finally {
    await f.close();
  }
});

Deno.test('a blocked domain cannot starve another stream or periodic hello with a live WS connection', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const lateDelivered = Promise.withResolvers<void>();
  const periodicHello = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let worker: ReturnType<typeof startHomeLinkWorker> | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const blocked = {
      source: 'edge_a',
      incarnation: client.peer.incarnation,
      stream: 'room:a-blocked',
    };
    const free = { ...blocked, stream: 'room:z-free' };
    const one = await f.fj.append('home', {
      ...blocked,
      type: 'control',
      version: 1,
      operationId: 'blocked',
      payload: 1,
    });
    const two = await f.fj.append('home', {
      ...free,
      type: 'control',
      version: 1,
      operationId: 'free',
      payload: 2,
    });
    let hellos = 0;
    const original = client.hello.bind(client);
    client.hello = (signal) => {
      if (++hellos >= 4) periodicHello.resolve();
      return original(signal);
    };
    worker = startHomeLinkWorker({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      notify: 'websocket',
      pollseconds: 0.02,
      reconnectmaxseconds: 0.04,
      failed: (error) => failures.push(error),
      apply: async (stream) => {
        const next = await f.hj.next('edge_a', stream);
        if (!next) return false;
        if (stream.stream === blocked.stream) {
          entered.resolve();
          await release.promise;
        }
        await f.hj.complete('edge_a', stream, next, { exact: next.payload });
        if (stream.stream === free.stream) delivered.resolve();
        if (next.payload === 3) lateDelivered.resolve();
        return true;
      },
    });
    // Test deadline only: distinguishes progress from an accidental global wait.
    await testDeadline(
      Promise.all([entered.promise, delivered.promise, periodicHello.promise]),
    );
    assertEquals(await f.hj.result('edge_a', 'in', blocked, one), null);
    assertEquals(await f.hj.result('edge_a', 'in', free, two), {
      result: { exact: 2 },
    });
    // Deliberately omit the hub wakeup while the WS connection stays open.
    const late = await f.fj.append('home', {
      ...free,
      type: 'control',
      version: 1,
      operationId: 'missed-notice',
      payload: 3,
    });
    await testDeadline(lateDelivered.promise);
    assertEquals(await f.hj.result('edge_a', 'in', free, late), {
      result: { exact: 3 },
    });
    const closing = worker.close();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    assertEquals(closed, false);
    release.resolve();
    await testDeadline(closing);
    assertEquals(await f.hj.result('edge_a', 'in', blocked, one), {
      result: { exact: 1 },
    });
    assertEquals(
      failures.filter((error) =>
        !(error instanceof DOMException && error.name === 'AbortError')
      ),
      [],
    );
  } finally {
    release.resolve();
    await worker?.close();
    await f.close();
  }
});

Deno.test('reconciliation preserves an outgoing wake received during an in-flight push', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let reconciler: JournalReconciler | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const base = {
      source: 'home',
      incarnation: bundle.id,
      stream: 'egress:wake.test',
      type: 'control',
      version: 1,
    };
    const first = await f.hj.append('edge_a', {
      ...base,
      operationId: 'first',
      payload: 1,
    });
    const push = client.push.bind(client);
    let blocked = false;
    client.push = async (...args) => {
      const result = await push(...args);
      if (!blocked) {
        blocked = true;
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      apply: () => Promise.resolve(false),
      failed: (error) => failures.push(error),
    });
    await reconciler.reconcile();
    await testDeadline(entered.promise);
    const second = await f.hj.append('edge_a', {
      ...base,
      operationId: 'second',
      payload: 2,
    });
    await reconciler.reconcile();
    release.resolve();
    await reconciler.drain();
    assertEquals(
      (await f.fj.heads('home', 'in', first)).received.sequence,
      second.sequence,
    );
    assertEquals(
      failures,
      [],
      'a fresh reconciliation must not compare ACKs to stale hello cuts',
    );
  } finally {
    release.resolve();
    await reconciler?.drain();
    await f.close();
  }
});

Deno.test('reconciliation preserves an incoming notice while its domain is finishing a pass', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let reconciler: JournalReconciler | undefined;
  try {
    const bundle = await f.create();
    await f.fp.accept(bundle);
    await enrollLink(f.hp, bundle.id, f.tls.home, bundle.secret);
    const client = await openJournalClient(f.hp, bundle.id, f.tls.home);
    const base = {
      source: 'edge_a',
      incarnation: client.peer.incarnation,
      stream: 'ingress:wake.test',
      type: 'control',
      version: 1,
    };
    const first = await f.fj.append('home', {
      ...base,
      operationId: 'first',
      payload: 1,
    });
    let blocked = false;
    reconciler = new JournalReconciler({
      client,
      journal: f.hj,
      limits: { maxItems: 1, maxBytes: 1000 },
      failed: (error) => failures.push(error),
      apply: async (stream) => {
        const record = await f.hj.next('edge_a', stream);
        if (record) {
          await f.hj.complete('edge_a', stream, record, {
            exact: record.payload,
          });
          return true;
        }
        if (!blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return false;
      },
    });
    await reconciler.reconcile();
    await testDeadline(entered.promise);
    const second = await f.fj.append('home', {
      ...base,
      operationId: 'second',
      payload: 2,
    });
    await reconciler.reconcile();
    release.resolve();
    await reconciler.drain();
    assertEquals(
      (await f.hj.heads('edge_a', 'in', first)).applied.sequence,
      second.sequence,
    );
    assertEquals(failures, []);
  } finally {
    release.resolve();
    await reconciler?.drain();
    await f.close();
  }
});

async function testDeadline<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('stream progress deadline')),
          3000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

Deno.test('facade inbox application is independent per stream and drains without a home socket', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const failed: unknown[] = [];
  let worker: ReturnType<typeof startInboxWorker> | undefined;
  try {
    const base = { source: 'home', incarnation: 'pair-inbox' };
    const one = await f.hj.append('edge_a', {
      ...base,
      stream: 'room:a-blocked',
      type: 'control',
      version: 1,
      operationId: 'a',
      payload: 1,
    });
    const two = await f.hj.append('edge_a', {
      ...base,
      stream: 'room:z-free',
      type: 'control',
      version: 1,
      operationId: 'z',
      payload: 2,
    });
    await f.fj.receive('home', [one]);
    await f.fj.receive('home', [two]);
    worker = startInboxWorker({
      journal: f.fj,
      peer: 'home',
      pollseconds: 0.02,
      changed() {},
      failed: (error) => failed.push(error),
      apply: async (stream) => {
        const next = await f.fj.next('home', stream);
        if (!next) return false;
        if (next.operationId === 'a') {
          entered.resolve();
          await release.promise;
        }
        await f.fj.complete('home', stream, next, { applied: next.payload });
        if (next.operationId === 'z') delivered.resolve();
        return true;
      },
    });
    await testDeadline(Promise.all([entered.promise, delivered.promise]));
    assertEquals(await f.fj.result('home', 'in', one, one), null);
    assertEquals(await f.fj.result('home', 'in', two, two), {
      result: { applied: 2 },
    });
    const close = worker.close();
    release.resolve();
    await testDeadline(close);
    assertEquals(await f.fj.result('home', 'in', one, one), {
      result: { applied: 1 },
    });
    assertEquals(failed, []);
  } finally {
    release.resolve();
    await worker?.close();
    await f.close();
  }
});

Deno.test('facade inbox retains a wake during its final empty domain check', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rescanned = Promise.withResolvers<void>();
  const delivered = Promise.withResolvers<void>();
  const failures: unknown[] = [];
  let worker: ReturnType<typeof startInboxWorker> | undefined;
  try {
    const base = {
      source: 'home',
      incarnation: 'inbox-wake',
      stream: 'room:inbox',
      type: 'control',
      version: 1,
    };
    const first = await f.hj.append('edge_a', {
      ...base,
      operationId: 'first',
      payload: 1,
    });
    await f.fj.receive('home', [first]);
    const streams = f.fj.streams.bind(f.fj);
    let blocked = false;
    f.fj.streams = async (...args) => {
      const result = await streams(...args);
      if (blocked) rescanned.resolve();
      return result;
    };
    worker = startInboxWorker({
      journal: f.fj,
      peer: 'home',
      pollseconds: 60,
      changed() {},
      failed: (error) => failures.push(error),
      apply: async (stream) => {
        const next = await f.fj.next('home', stream);
        if (next) {
          await f.fj.complete('home', stream, next, { exact: next.payload });
          if (next.payload === 2) delivered.resolve();
          return true;
        }
        if (!blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return false;
      },
    });
    await testDeadline(entered.promise);
    const second = await f.hj.append('edge_a', {
      ...base,
      operationId: 'second',
      payload: 2,
    });
    await f.fj.receive('home', [second]);
    worker.wake();
    await testDeadline(rescanned.promise);
    release.resolve();
    await testDeadline(delivered.promise);
    assertEquals((await f.fj.heads('home', 'in', second)).applied.sequence, 2);
    assertEquals(failures, []);
  } finally {
    release.resolve();
    await worker?.close();
    await f.close();
  }
});

for (const fault of ['apply', 'enumeration'] as const) {
  Deno.test(`facade inbox retains a wake across a failed ${fault} pass`, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const rescanned = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    const failures: unknown[] = [];
    const failure = new Error('injected inbox pass failure');
    let injected = false;
    let worker: ReturnType<typeof startInboxWorker> | undefined;
    try {
      const record = await f.hj.append('edge_a', {
        source: 'home',
        incarnation: 'inbox-error-wake',
        stream: 'room:retry',
        type: 'control',
        version: 1,
        operationId: 'retry',
        payload: 1,
      });
      await f.fj.receive('home', [record]);
      const streams = f.fj.streams.bind(f.fj);
      let scans = 0;
      f.fj.streams = async (...args) => {
        scans++;
        if (fault === 'enumeration' && !injected) {
          injected = true;
          entered.resolve();
          await release.promise;
          throw failure;
        }
        const result = await streams(...args);
        if (scans > 1) setTimeout(() => rescanned.resolve(), 0);
        return result;
      };
      worker = startInboxWorker({
        journal: f.fj,
        peer: 'home',
        pollseconds: 60,
        changed() {},
        failed: (error) => failures.push(error),
        apply: async (stream) => {
          if (fault === 'apply' && !injected) {
            injected = true;
            entered.resolve();
            await release.promise;
            throw failure;
          }
          const next = await f.fj.next('home', stream);
          if (!next) return false;
          await f.fj.complete('home', stream, next, { applied: true });
          delivered.resolve();
          return true;
        },
      });
      await testDeadline(entered.promise);
      worker.wake();
      if (fault === 'apply') await testDeadline(rescanned.promise);
      release.resolve();
      await testDeadline(delivered.promise);
      assertEquals(failures, [failure]);
    } finally {
      release.resolve();
      await worker?.close();
      await f.close();
    }
  });
}
