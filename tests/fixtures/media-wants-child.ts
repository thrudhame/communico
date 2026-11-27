import { theApp } from '#engine/app.ts';
import { StoragePressureError } from '#engine/store/pressure.ts';
import { LINK_PREFIX, LinkClient } from '#engine/facade/transport.ts';

const control = Deno.env.get('COMMUNICO_CONFIG') + '.media-wants';
const call = LinkClient.prototype.fetch;
LinkClient.prototype.fetch = async function (path, init) {
  const response = await call.call(this, path, init);
  if (path === LINK_PREFIX + 'media-applied' && response.ok) {
    const { applied } = await response.clone().json();
    await Deno.writeTextFile(`${control}.applied`, applied.id + '\n', {
      append: true,
    });
  }
  return response;
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
    await Deno.writeTextFile(`${control}.pressure-result`, result);
  } finally {
    working = false;
  }
}, 20);
Deno.unrefTimer(timer);
