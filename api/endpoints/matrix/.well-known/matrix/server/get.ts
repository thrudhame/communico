// GET /.well-known/matrix/server — delegation (wellknown.yaml:33-57).
// Served iff federation.enabled and wellknown is non-empty; otherwise a
// PLAIN 404 — this is not a /_matrix route, so it carries no Matrix
// errcode shape, just status.
import { config } from '#engine/config.ts';
import { HttpError } from '@pathfinder/pathfinder';

// deno-lint-ignore require-await
export default async function () {
  const fed = config().federation;
  if (!(fed.enabled && fed.wellknown !== '')) {
    throw new HttpError(404, 'not found');
  }
  return new Response(
    JSON.stringify({ 'm.server': fed.wellknown }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${fed.wellknownmaxage}`,
      },
    },
  );
}
