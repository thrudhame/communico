import { pathfinder } from '@pathfinder/pathfinder';

// One listener: the Matrix client-server API. The port comes from the
// environment — no in-code fallback (ruling 8); the full required-config
// validation (api/engine/config.ts) centralizes this in the next step.
const appPort = Deno.env.get('APP_PORT');
if (appPort === undefined || !Number.isInteger(Number(appPort))) {
  console.error('missing required environment variable APP_PORT');
  Deno.exit(1);
}

const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });

Deno.serve({ port: Number(appPort) }, matrix);