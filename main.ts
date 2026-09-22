import { appPort, ConfigError, loadedConfig } from '#engine/config.ts';
import { mediaRoot } from '#engine/media.ts';
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
} catch (e) {
  if (e instanceof ConfigError) {
    for (const problem of e.problems) console.error(problem);
    Deno.exit(1);
  }
  throw e;
}

await Deno.mkdir(mediaRoot(), { recursive: true });

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

Deno.serve({ port: appPort() }, matrix);
