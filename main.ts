import { appPort, config, ConfigError, loadedConfig } from '#engine/config.ts';
import { mediaRoot } from '#engine/media.ts';
import { wireFederationTransport } from '#engine/federation/client.ts';
import { startSender } from '#engine/federation/sender.ts';
import { sweepExpiredPlaceholders } from '#engine/ingest.ts';
import {
  listBlocks,
  listPeers,
  listPending,
} from '#engine/federation/peers.ts';
import { pathfinder } from '@pathfinder/pathfinder';

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
    const absCert = Deno.realPathSync(fed.cert);
    // counts read the runtime tables; before db-init provisions them
    // (the demo starts the app first) the reads fail — render '?'
    const safeCount = async (fn: () => Promise<unknown[]>): Promise<string> => {
      try {
        return String((await fn()).length);
      } catch {
        return '?';
      }
    };
    const peers = await safeCount(listPeers);
    const blocks = await safeCount(listBlocks);
    const pending = await safeCount(listPending);
    console.log(
      `federation: enabled port=${fed.port} mode=${fed.mode} cert=${absCert} cacerts=${fed.cacerts.length} peers=${peers} blocks=${blocks} pending=${pending}`,
    );
  } else {
    console.log('federation: disabled');
  }
} catch (e) {
  if (e instanceof ConfigError) {
    for (const problem of e.problems) console.error(problem);
    Deno.exit(1);
  }
  throw e;
}

if (config().federation.enabled) {
  wireFederationTransport();
  // ruling B expiry: lapsed 'ungrounded' placeholders leave at startup
  // (and on each room's next write); the table may not exist yet on a
  // fresh container's first boot (db-init runs after the app)
  void sweepExpiredPlaceholders().catch(() => {});
  startSender();
}

await Deno.mkdir(mediaRoot(), { recursive: true });

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

Deno.serve({ port: appPort() }, matrix);

if (config().federation.enabled) {
  const { cert, key, port } = config().federation;
  // the same app on both listeners (Synapse's single-listener shape;
  // Complement probes /_matrix/federation/* and /_matrix/key/* on 8008)
  Deno.serve({
    port,
    cert: await Deno.readTextFile(cert),
    key: await Deno.readTextFile(key),
  }, matrix);
}
