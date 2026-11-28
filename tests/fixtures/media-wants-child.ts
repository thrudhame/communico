import { theApp } from '#engine/app.ts';
import { Pairings } from '#engine/facade/pairing.ts';
import {
  type ObserveCut,
  ReplicaCutPending,
  ReplicaReadiness,
} from '#engine/facade/readiness.ts';
import { LINK_PREFIX, LinkClient } from '#engine/facade/transport.ts';
import { Conn } from '#engine/store/db.ts';
import { StoragePressureError } from '#engine/store/pressure.ts';
import { beforeFacadePublication } from '#tests/helpers/facade-process.ts';

const control = Deno.env.get('COMMUNICO_CONFIG') + '.media-wants';
const marker = (suffix: string) => {
  try {
    return Deno.readTextFileSync(`${control}.${suffix}`);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
};
const rollback = new Error('fixture rolls back retirement');
const execute = Conn.prototype.execute;
Conn.prototype.execute = async function (sql, values) {
  if (sql.startsWith('INSERT INTO media_wants(')) {
    const target = marker('deny-want');
    if (target !== undefined && target === values?.[0]) {
      Deno.writeTextFileSync(`${control}.denied`, `${target}\n`, {
        append: true,
      });
      throw new StoragePressureError();
    }
  }
  if (
    sql === 'UPDATE facade_control SET revision=? WHERE singleton=1' &&
    marker('fail-retire') === 'once'
  ) {
    await beforeFacadePublication('wanted-retire-rollback');
    await execute.call(this, sql, values);
    Deno.removeSync(`${control}.fail-retire`);
    throw rollback;
  }
  return await execute.call(this, sql, values);
};
const retire = Pairings.prototype.retire;
Pairings.prototype.retire = async function (raw, pin) {
  try {
    return await retire.call(this, raw, pin);
  } catch (error) {
    if (error !== rollback) throw error;
    // Let the test observe the rolled back authority before replaying the
    // same signed revocation. Only the injected failure is handled here.
    await beforeFacadePublication('wanted-retire-retry');
    return await retire.call(this, raw, pin);
  }
};
const wait = ReplicaReadiness.prototype.wait;
ReplicaReadiness.prototype.wait = function <T>(
  read: (observe: ObserveCut) => Promise<T>,
  signal: AbortSignal,
  remoteDeadline?: AbortSignal,
) {
  return (wait<T>).call(
    this,
    async (observe) => {
      try {
        return await read(observe);
      } catch (error) {
        if (
          error instanceof ReplicaCutPending &&
          error.stream.startsWith('media-want:')
        ) {
          // The demand transaction has finished; hold only this reader.
          await beforeFacadePublication('wanted-reader');
        }
        throw error;
      }
    },
    signal,
    remoteDeadline,
  );
};
const trace = (event: unknown) =>
  Deno.writeTextFileSync(`${control}.trace`, JSON.stringify(event) + '\n', {
    append: true,
  });
const call = LinkClient.prototype.fetch;
LinkClient.prototype.fetch = async function (path, init) {
  const route = path.slice(LINK_PREFIX.length);
  trace({ route });
  if (route === 'media-push') {
    const { id, demand, chunk: { offset } } = JSON.parse(String(init?.body));
    trace({ route, id, demand, offset });
    // A nonzero request offset is the facade's previous durable ACK.
    if (offset > 0) await beforeFacadePublication('wanted-partial');
  }
  const response = await call.call(this, path, init);
  if (route === 'media-wanted' && response.ok) {
    const { wanted } = await response.clone().json();
    trace({ route, wanted });
  }
  if (route === 'media-applied' && response.ok) {
    const { applied } = await response.clone().json();
    await Deno.writeTextFile(`${control}.applied`, applied.id + '\n', {
      append: true,
    });
  }
  return response;
};
const notices = LinkClient.prototype.websocket;
LinkClient.prototype.websocket = function (path, init) {
  trace({ route: path.slice(LINK_PREFIX.length) });
  return notices.call(this, path, init);
};

const link = Deno.link;
Deno.link = async (from, to) => {
  if (String(from).endsWith('.wanted.part')) {
    // The complete stage is durable, but no bytes are published yet.
    await beforeFacadePublication('wanted-install');
  }
  await link(from, to);
};

const open = Deno.open;
Deno.open = async (path, options) => {
  const file = await open(path, options);
  const original = /\/facade-media\/([A-Za-z0-9_-]+)$/.exec(String(path));
  if (original && options?.read && !options.write) {
    await beforeFacadePublication(`original-lease:${original[1]}`);
  }
  return file;
};

await import('./facade-child.ts');

// Trigger real shared capacity admission in the facade, independently of a
// consumer read or another upload. No pressure file is actually allocated.
let working = false;
const timer = setInterval(async () => {
  if (working) return;
  working = true;
  try {
    let path: string;
    try {
      path = await Deno.readTextFile(`${control}.pressure`);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    await Deno.remove(`${control}.pressure`);
    const capacity = theApp().store.capacity!;
    const [disk] = (await capacity.status()).filesystems;
    let result = 'admitted';
    try {
      (await capacity.reserveStaging(
        path,
        // Leave a shortfall bigger than the other (legacy) cached original,
        // independent of scratch accounting or transient database work.
        disk.budgetBytes! - capacity.accountedBytes() + 128 * 1024,
      )).release();
    } catch (error) {
      if (!(error instanceof StoragePressureError)) throw error;
      result = 'pressure';
    }
    const receipt = `${control}.pressure-result`;
    await Deno.writeTextFile(`${receipt}.new`, result);
    await Deno.rename(`${receipt}.new`, receipt);
  } finally {
    working = false;
  }
}, 20);
Deno.unrefTimer(timer);
