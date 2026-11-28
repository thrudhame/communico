import { assert, assertEquals, assertRejects } from '@std/assert';
import { canonicalJson } from '#engine/canonical.ts';
import { exported, sha256 } from '#engine/facade/media-copy.ts';
import {
  FacadeMediaWants,
  HomeMediaWants,
} from '#engine/facade/media-wants.ts';
import { LinkError } from '#engine/facade/protocol.ts';
import {
  type ObserveCut,
  ReplicaCutPending,
  ReplicaReadiness,
} from '#engine/facade/readiness.ts';
import { MediaCache } from '#engine/media/cache.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { Capacity } from '#engine/store/capacity.ts';
import { openStore } from '#engine/store/index.ts';
import { openTenant, tenantSchema } from '#engine/tenant/index.ts';

const server = 'logical.test', pairing = 'pairing', id = 'legacy';
const body = 'verified wanted original';
const limits = { maxBytes: 8192, maxItems: 8 };
const row = {
  media_id: id,
  localpart: 'owner',
  state: 'uploaded' as const,
  content_type: 'text/plain',
  filename: null,
  created_ms: 1,
  uploaded_ms: 2,
  size_bytes: body.length,
  sha256: sha256(body),
};
const manifest = exported(row, server, String);

class Readiness extends ReplicaReadiness {
  // Hold the current probe after recording demand, outside its media lane.
  hold?: () => Promise<void>;

  override wait<T>(
    read: (observe: ObserveCut) => Promise<T>,
    signal: AbortSignal,
    deadline?: AbortSignal,
  ) {
    return super.wait(
      async (observe) => {
        try {
          return await read(observe);
        } catch (error) {
          if (error instanceof ReplicaCutPending) await this.hold?.();
          throw error;
        }
      },
      signal,
      deadline,
    );
  }
}

async function fixture() {
  const dir = await Deno.makeTempDir({ prefix: 'facade-media-wants-' });
  const resources = new AsyncDisposableStack();
  resources.defer(() => Deno.remove(dir, { recursive: true }));
  try {
    const root = dir + '/edge-media', homeRoot = dir + '/home-media';
    const open = (side: string) =>
      openStore({
        dir: `${dir}/${side}`,
        library: './.native/libturso_ffi.so',
        checkpointlogbytes: 65536,
        maxopenfiles: 8,
        idleseconds: 300,
      }, { schemas: { server: serverSchema, tenant: tenantSchema } });
    const edge = await open('edge');
    resources.defer(() => edge.close());
    const home = await open('home');
    resources.defer(() => home.close());
    const tenant = await openTenant(edge, server, { create: true });
    const source = await openTenant(home, server, { create: true });
    await source.tx((tx) => tx.media.insertCopy(row));
    await Deno.mkdir(homeRoot);
    await Deno.writeTextFile(`${homeRoot}/${id}`, body);
    const capacity = new Capacity([root]);
    await capacity.ensureDirectory(root);
    const cache = new MediaCache(await edge.server(), root, 32, capacity);
    resources.defer(() => cache.close());
    cache.bindOriginals(pairing);
    const readiness = new Readiness({
      canDeliver: () => true,
      onDeliveryLoss: () => () => {},
    });
    resources.defer(() => readiness.close());
    const receiver = new FacadeMediaWants(
      tenant,
      root,
      'edge_a',
      limits,
      capacity,
      readiness,
      3000,
      cache,
    );
    const sender = new HomeMediaWants(source, homeRoot);
    return {
      [Symbol.asyncDispose]: () => resources.disposeAsync(),
      receiver,
      capacity,
      path: `${root}/${id}`,
      part: `${root}/${id}.wanted.part`,
      wanted: () => tenant.tx((tx) => tx.media.wanted(id)),
      checkIn: () =>
        sender.reconcile(
          (route, fields) => receiver.exchange(route, pairing, fields),
          limits,
          (error) => {
            throw error;
          },
          AbortSignal.timeout(3000),
        ),
      holdReader() {
        const waiting = Promise.withResolvers<void>();
        const held = Promise.withResolvers<void>();
        readiness.hold = () => {
          waiting.resolve();
          return held.promise;
        };
        return {
          waiting: waiting.promise,
          release: () => {
            readiness.hold = undefined;
            held.resolve();
          },
        };
      },
      read: (signal: AbortSignal) => receiver.read(id, pairing, signal),
      async stageFull() {
        const demand = 'recover-full-cut';
        await tenant.tx(async (tx) => {
          await tx.media.want(id, demand);
          await tx.media.stageWant(
            id,
            canonicalJson({ pairing, manifest }),
            body.length,
          );
        });
        return demand;
      },
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}

async function expectOriginal(f: Awaited<ReturnType<typeof fixture>>) {
  using original = await f.receiver.open(id);
  assert(original);
  assertEquals(await Deno.readTextFile(f.path), body);
  assertEquals(await f.wanted(), null);
}

Deno.test('05-media-wants: bound reader renews demand after publication is evicted', async () => {
  await using f = await fixture();
  const stop = new AbortController();
  const first = f.holdReader();
  const read = f.read(stop.signal);
  void read.catch(() => {});
  try {
    await Promise.race([first.waiting, read]);
    const old = await f.wanted();
    assert(old);
    await f.checkIn();
    await expectOriginal(f);
    await f.capacity.remove(f.path);
    first.release();
    const second = f.holdReader();
    try {
      await Promise.race([second.waiting, read]);
      const renewed = await f.wanted();
      assert(renewed, 'the same reader must durably renew missing demand');
      assert(renewed.demand !== old.demand);
      await f.checkIn();
    } finally {
      second.release();
    }
    await read;
    await expectOriginal(f);
  } finally {
    first.release();
    stop.abort();
    await read.catch(() => {});
  }
});

Deno.test('05-media-wants: wire rejects corrupt full staging and frees it before retry', async () => {
  await using f = await fixture();
  const demand = await f.stageFull();
  await Deno.writeTextFile(f.part, 'x'.repeat(body.length));
  const error = await assertRejects(
    () =>
      f.receiver.exchange('media-reply', pairing, {
        id,
        demand,
        state: 'uploaded',
        manifest,
      }),
    LinkError,
  );
  assertEquals(error.code, 'LINK_DIVERGED');
  assertEquals((await f.wanted())?.bytes, 0);
  await assertRejects(() => Deno.stat(f.part), Deno.errors.NotFound);
  await f.checkIn();
  await expectOriginal(f);
});

Deno.test('05-media-wants: same reader waits for home after a locally recovered full cut resets', async () => {
  await using f = await fixture();
  const demand = await f.stageFull();
  const waiting = f.holdReader();
  const stop = new AbortController();
  const read = f.read(stop.signal);
  void read.catch(() => {});
  try {
    await Promise.race([waiting.waiting, read]);
    const reset = await f.wanted();
    assertEquals(reset?.bytes, 0);
    assertEquals(reset?.demand, demand);
    await f.checkIn();
    waiting.release();
    await read;
    await expectOriginal(f);
  } finally {
    waiting.release();
    stop.abort();
    await read.catch(() => {});
  }
});
