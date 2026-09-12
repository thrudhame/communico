import { pathfinder } from '@pathfinder/pathfinder';

// Two listeners, two roots (plan §9.1): :8008 serves the Matrix client API
// only, :8000 serves the communico tree (_communico/* + the root-level
// /msync lite-hat socket). Each instance is its own app with its own
// Layer-0 /_status subtree. The tagline at / is a root get.ts in each tree.
const matrix = await pathfinder({ roots: ['api/endpoints/matrix/'] });
const communico = await pathfinder({ roots: ['api/endpoints/communico/'] });

Deno.serve({ port: Number(Deno.env.get('APP_A_PORT') ?? '8008') }, matrix);
Deno.serve({ port: Number(Deno.env.get('APP_B_PORT') ?? '8000') }, communico);
