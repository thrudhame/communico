import { assertEquals, assertRejects, assertStrictEquals } from '@std/assert';
import { setConfigForTests } from '#engine/config.ts';
import { certificatePin } from '#engine/facade/identity.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import { LINK_CAPABILITIES, LINK_VERSION } from '#engine/facade/protocol.ts';
import { openFacadeRuntime } from '#engine/facade/runtime.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';
import { facadeTls } from './support/facade-tls.ts';

async function contactLifetime(fault?: Error) {
  const tls = await facadeTls();
  const options = (side: string) => ({
    dir: tls.dir + '/' + side,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  setConfigForTests({
    server: { name: 'logical.test', role: 'facade' },
    federation: { enabled: false },
    facade: {
      nodeid: 'edge_a',
      url: 'https://facade.test',
      pairfile: '',
      linkcert: tls.dir + '/facade.crt',
      linkkey: tls.dir + '/facade.key',
      linkcacerts: [tls.dir + '/ca.crt'],
    },
  });
  const home = await openStore(options('home'), {
    schemas: { server: serverSchema, tenant: tenantSchema },
  });
  const runtime = await openFacadeRuntime(options('edge'));
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const admitted = Promise.withResolvers<void>();
  const authorize = Pairings.prototype.authorizedHome;
  const writes: number[] = [];
  const responses: number[] = [];
  let admissions = 0;
  let requests: Promise<void>[] = [];
  let closed = false;
  try {
    const tenant = await openTenant(home, 'logical.test', { create: true });
    await runtime.initialize();
    const homePin = certificatePin(tls.home.cert);
    const hp = new Pairings(
      await home.server(),
      tenant.signer(),
      tenant.publicB64,
      homePin,
    );
    const fp = await runtime.pairings();
    const bundle = await hp.create({
      node: 'edge_a',
      url: 'https://facade.test',
      facadePin: certificatePin(tls.facade.cert),
      expires: Date.now() + 60000,
      required: [...LINK_CAPABILITIES],
    });
    await fp.accept(bundle);
    const grant = await hp.grant(
      bundle.id,
      await fp.challenge(bundle.id, bundle.secret, homePin),
    );
    await hp.confirm(bundle.id, await fp.complete(bundle.id, grant, homePin));
    const tx = runtime.server.tx.bind(runtime.server);
    runtime.server.tx = (fn, settings) =>
      tx(async (conn) => {
        const execute = conn.execute.bind(conn);
        conn.execute = async (sql, values) => {
          if (sql.startsWith('UPDATE facade_key_roster SET last_home_ms=')) {
            writes.push(Number(values?.[0]));
            if (writes.length === 1) {
              entered.resolve();
              await release.promise;
              if (fault) throw fault;
            }
          }
          return await execute(sql, values);
        };
        return await fn(conn);
      }, settings);
    Pairings.prototype.authorizedHome = async function (...args) {
      const grant = await authorize.apply(this, args);
      if (++admissions === 16) admitted.resolve();
      return grant;
    };
    // Isolate the contact boundary from unrelated journal I/O. Authentication
    // and the retained diagnostic transaction still use the real native store.
    runtime.journal.streams = () => Promise.resolve([]);
    const envelope = {
      protocol: LINK_VERSION,
      server: 'logical.test',
      required: LINK_CAPABILITIES,
      source: 'home',
      incarnation: bundle.id,
      pairing: bundle.id,
    };
    const call = async () => {
      const started = performance.now();
      const response = await runtime.handle(
        new Request('https://facade.test/_communico/link/v1/hello', {
          headers: { 'x-communico-link': JSON.stringify(envelope) },
        }),
        homePin,
      );
      assertEquals(response.status, 200);
      await response.body?.cancel();
      responses.push(performance.now() - started);
    };
    requests = [call()];
    await entered.promise;
    requests.push(...Array.from({ length: 15 }, call));
    await admitted.promise;
    // Flush the runnable promise chain once, not a latency deadline. A held
    // transaction cannot resolve in this turn regardless of machine speed.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    console.log(
      'held contact completions:',
      responses.length,
      'of 16; latency ms:',
      responses,
    );
    assertEquals(
      responses.length,
      16,
      'no authenticated response waits on diagnostic persistence',
    );
    const closing = runtime.close();
    void closing.then(() => {
      closed = true;
    }, () => {
      closed = true;
    });
    await Promise.resolve();
    assertEquals(closed, false, 'shutdown retains the outstanding write');
    release.resolve();
    if (fault) assertStrictEquals(await assertRejects(() => closing), fault);
    else await closing;
    assertEquals(
      writes.length,
      fault ? 1 : 2,
      'one in-flight flush and one coalesced suffix',
    );
    const reopened = await openStore(options('edge'), {
      schemas: { server: serverSchema, tenant: tenantSchema },
    });
    try {
      const [row] = await (await reopened.server()).query(
        'SELECT last_home_ms FROM facade_key_roster WHERE singleton=1',
      );
      assertEquals(row.last_home_ms, fault ? null : Math.max(...writes));
    } finally {
      await reopened.close();
    }
  } finally {
    release.resolve();
    await Promise.allSettled(requests);
    Pairings.prototype.authorizedHome = authorize;
    if (fault && writes.length > 0) await assertRejects(() => runtime.close());
    else await runtime.close();
    await home.close();
    await tls.close();
    setConfigForTests({});
  }
}

Deno.test('home contact diagnostics never hold authenticated requests and shutdown drains the exact maximum', () =>
  contactLifetime());
Deno.test('home contact failures stay owned by shutdown without failing authenticated requests or retaining open storage', () =>
  contactLifetime(new Error('injected contact persistence failure')));
