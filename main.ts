import { appPort, config, ConfigError, loadedConfig } from '#engine/config.ts';
import { closeApp, openApp, startFederationServices } from '#engine/app.ts';
import {
  listBlocks,
  listPeers,
  listPending,
} from '#engine/federation/peers.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { mediaRoot } from '#engine/media.ts';
import { startAdmin } from '#root/api/admin/index.ts';
import { ServerLifetime } from '#root/api/server-lifetime.ts';
import { startFacade } from '#root/api/facade.ts';
import { startHomeLinks } from '#engine/facade/home.ts';

const lifetime = new ServerLifetime();
let fatal = false;
let closing: Promise<void> | undefined;
let stopRuntime: () => Promise<void> = closeApp;
function closeStore(): Promise<void> {
  return closing ??= stopRuntime();
}

globalThis.addEventListener('unhandledrejection', (event) => {
  if (fatal) Deno.exit(1);
  fatal = true;
  // Defer Deno's immediate fatal default only for bounded cleanup. Continuing
  // to serve, recovering from the rejection or exiting successfully is forbidden.
  event.preventDefault();
  lifetime.abort();
  console.error('fatal: unhandled rejection');
  console.error(
    event.reason instanceof Error
      ? event.reason.stack
      : new Error(String(event.reason)).stack,
  );
  const timer = setTimeout(() => Deno.exit(1), 2000);
  void closeStore().then(() => {
    console.error('fatal: store closed');
    clearTimeout(timer);
    Deno.exit(1);
  }, (error) => {
    console.error('fatal: store close failed', error);
    clearTimeout(timer);
    Deno.exit(1);
  });
});

try {
  const loaded = loadedConfig();
  const absDefaults = Deno.realPathSync(loaded.defaultsPath);
  const absConfig = loaded.configPath === null
    ? 'none'
    : Deno.realPathSync(loaded.configPath);
  const envOverrides = Object.entries(loaded.sources)
    .filter(([, src]) => src === 'env')
    .map(([node]) => node);
  console.log(
    `config: defaults=${absDefaults} config=${absConfig} env-overrides: ${
      envOverrides.join(', ')
    }`,
  );
  if (
    loaded.config.preview.enabled &&
    loaded.config.preview.blocklist.length === 0
  ) {
    console.log(
      'preview: enabled with an empty blocklist — every address is reachable',
    );
  }
  const fed = loaded.config.federation;
  if (fed.enabled && loaded.config.server.role === 'home') {
    // existence checked here, not at config load (tests and the demo load
    // config without a certificate)
    try {
      await Deno.lstat(fed.cert);
      await Deno.lstat(fed.key);
    } catch {
      console.error(
        `federation.cert (COMMUNICO_FEDERATION_CERT): file not found: ${fed.cert} — provide a certificate or set federation.enabled = false`,
      );
      Deno.exit(1);
    }
  }
} catch (e) {
  if (e instanceof ConfigError) {
    for (const problem of e.problems) console.error(problem);
    Deno.exit(1);
  }
  throw e;
}

let admin: { shutdown(): Promise<void> };
const servers: Deno.HttpServer[] = [];
if (config().server.role === 'facade') {
  const facade = await startFacade(lifetime);
  admin = facade.admin;
  stopRuntime = facade.close;
  console.log('facade: link/local admin ready; Matrix scopes not yet ready');
} else {
  await Deno.mkdir(mediaRoot(), { recursive: true });
  const app = await openApp();
  try {
    const links = await startHomeLinks(app);
    stopRuntime = async () => {
      await links.close();
      await closeApp();
    };
    admin = await startAdmin(app, undefined, lifetime);
  } catch (error) {
    await closeStore();
    throw error;
  }

  if (config().federation.enabled) {
    const fed = config().federation;
    const absCert = Deno.realPathSync(fed.cert);
    // the store is provisioned synchronously at openApp, so the runtime
    // counts always read (the old '?' fallback answered the app's
    // first-boot-before-db-init dance, which no longer exists)
    const peers = (await listPeers(app.server)).length;
    const blocks = (await listBlocks(app.server)).length;
    const pending = (await listPending(app.server)).length;
    console.log(
      `federation: enabled port=${fed.port} mode=${fed.mode} cert=${absCert} cacerts=${fed.cacerts.length} peers=${peers} blocks=${blocks} pending=${pending}`,
    );
    startFederationServices(app);
  } else {
    console.log('federation: disabled');
  }

  const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

  servers.push(
    Deno.serve(
      { port: appPort(), signal: lifetime.controller.signal },
      lifetime.wrap('cs', matrix),
    ),
  );

  if (config().federation.enabled) {
    const { cert, key, port } = config().federation;
    // the same app on both listeners (Synapse's single-listener shape;
    // Complement probes /_matrix/federation/* and /_matrix/key/* on 8008)
    servers.push(
      Deno.serve({
        port,
        cert: await Deno.readTextFile(cert),
        key: await Deno.readTextFile(key),
        signal: lifetime.controller.signal,
      }, lifetime.wrap('federation', matrix)),
    );
  }
}

// Stop admission first; keep transports readable until admitted work drains.
// The store lock is released only after every listener (including admin) ends.
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  console.log('shutdown: draining');
  const remaining = await lifetime.drain(config().server.shutdowngraceseconds);
  const forced = Object.keys(remaining).length !== 0;
  if (forced) {
    console.error('shutdown: forced aborts', JSON.stringify(remaining));
  }
  await Promise.all([
    ...servers.map((server) => server.shutdown()),
    admin.shutdown(),
  ]);
  if (fatal) return;
  await closeStore();
  if (fatal) return;
  console.log('shutdown: store closed');
  Deno.exit(forced ? 1 : 0);
}
Deno.addSignalListener('SIGINT', () => void shutdown());
Deno.addSignalListener('SIGTERM', () => void shutdown());
