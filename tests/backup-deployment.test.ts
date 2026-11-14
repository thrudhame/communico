import { assert, assertEquals } from '@std/assert';
import { stringify } from '@std/toml';
import { loadConfig } from '#engine/config.ts';
import { restoreDeployment } from '#engine/backup/deployment.ts';
import type { Manifest } from '#engine/backup/manifest.ts';

for (const leaf of ['secret', 'password'] as const) {
  for (const value of ['explicit-target-value', '']) {
    Deno.test(`restore deployment: explicit target TURN ${leaf}=${value === '' ? 'empty' : 'value'} replaces archived external requirement`, async () => {
      const root = await Deno.makeTempDir({ prefix: 'deployment-override-' });
      try {
        const overlay = root + '/target.toml';
        await Deno.writeTextFile(
          overlay,
          '[server]\nname="restore.test"\n[federation]\nenabled=false\n[turn]\n' +
            leaf + '=' + JSON.stringify(value),
        );
        const paths = {
          defaultsPath: 'defaults/communico.toml',
          configPath: overlay,
        };
        const settings = { ...loadConfig({ ...paths, env: {} }), ...paths };
        const effective = {
          ...structuredClone(settings.config),
          turn: Object.fromEntries(
            Object.entries(settings.config.turn)
              .filter(([key]) => key !== 'secret' && key !== 'password'),
          ),
        };
        await Deno.writeTextFile(
          root + '/effective.toml',
          stringify(effective),
        );
        const manifest: Manifest = {
          format: 1,
          backupId: 'deployment',
          serverName: 'restore.test',
          applicationVersion: 'test',
          native: {
            turso_version: '',
            turso_rev: '',
            patches: [],
            default_features: false,
            features: [],
          },
          cut: { startedAt: '', endedAt: '', pauseMs: 0 },
          encryption: 'none',
          contains_signing_private_keys: true,
          contains_password_hashes: true,
          tenants: [],
          databases: [],
          media: [],
          exclusions: [],
          payloads: [],
          deployment: [{
            node: 'config.effective',
            source: overlay,
            path: 'deployment/effective.toml',
          }],
          configuration: {
            overlay: null,
            sources: {},
            externalSecrets: [
              'COMMUNICO_TURN_SECRET',
              'COMMUNICO_TURN_PASSWORD',
            ],
          },
        };
        const restored = await restoreDeployment(
          manifest,
          root,
          root + '/store',
          root + '/media',
          settings,
        );
        const config = loadConfig({
          defaultsPath: settings.defaultsPath,
          configPath: root + '/communico.toml',
          env: {},
        });
        assertEquals(config.config.turn[leaf], value);
        assert(
          !restored.externalSecrets.includes(
            'COMMUNICO_TURN_' + leaf.toUpperCase(),
          ),
        );
        assertEquals(restored.externalSecrets.length, 1);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  }
}
