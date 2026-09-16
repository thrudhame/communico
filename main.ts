import { appPort, missingRequired } from '#engine/config.ts';
import { mediaRoot } from '#engine/media.ts';
import { pathfinder } from '@pathfinder/pathfinder';

// Startup validation (ruling 8): every required variable must exist; all
// missing ones are listed in one pass, never the first only. Lazy reads
// in the engine keep this the first thing that runs.
const missing = missingRequired();
if (missing.length > 0) {
  for (const name of missing) {
    console.error(`missing required environment variable ${name}`);
  }
  Deno.exit(1);
}

// Media bytes live on disk under MEDIA_ROOT (plan §3.4) — the root must
// exist before the first upload.
await Deno.mkdir(mediaRoot(), { recursive: true });

// One listener: the Matrix client-server API.
const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

Deno.serve({ port: appPort() }, matrix);
