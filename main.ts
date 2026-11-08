import { appPort, config, ConfigError, loadedConfig } from '#engine/config.ts';
import { closeApp, openApp, startFederationServices } from '#engine/app.ts';
import {
  listBlocks,
  listPeers,
  listPending,
} from '#engine/federation/peers.ts';
import { pathfinder } from '@pathfinder/pathfinder';
import { mediaRoot } from '#engine/media.ts';

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
  if (fed.enabled) {
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

await Deno.mkdir(mediaRoot(), { recursive: true });
const app = await openApp();

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

const servers = [
  Deno.serve({ port: appPort() }, matrix),
];

if (config().federation.enabled) {
  const { cert, key, port } = config().federation;
  // the same app on both listeners (Synapse's single-listener shape;
  // Complement probes /_matrix/federation/* and /_matrix/key/* on 8008)
  servers.push(
    Deno.serve({
      port,
      cert: await Deno.readTextFile(cert),
      key: await Deno.readTextFile(key),
    }, matrix),
  );
}

// Clean shutdown closes the store: stop the listeners, then the app
// (sender stopped, files closed) and exit 0 — a SIGTERM must never
// leave a half-written database directory behind.
let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.allSettled(servers.map((server) => server.shutdown()));
  await closeApp();
  console.log('shutdown: store closed');
  Deno.exit(0);
}
Deno.addSignalListener('SIGINT', () => void shutdown());
Deno.addSignalListener('SIGTERM', () => void shutdown());
