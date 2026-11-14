// Local-only composition root. Public Matrix listeners never mount this handler.
import { dirname, resolve } from '@std/path';
import type { App } from '#engine/app.ts';
import { adminSocket, serverName } from '#engine/config.ts';
import metadata from '#root/deno.json' with { type: 'json' };
import { federationOperations } from './federation.ts';
import { roomOperations } from './rooms.ts';
import { reportOperations } from './reports.ts';
import { homeFacadeOperations } from './facade.ts';
import { operationHandler } from './handler.ts';
import { startAdminHandler } from './socket.ts';
import type { ServerLifetime } from '#root/api/server-lifetime.ts';

export function adminHandler(
  app: App,
): (request: Request) => Promise<Response> {
  const started = performance.now();
  return operationHandler({
    ...federationOperations(app),
    ...roomOperations(app),
    ...reportOperations(app),
    ...homeFacadeOperations(app),
    '/v1/status': () => ({
      server: serverName(),
      version: metadata.version,
      store: resolve(dirname(dirname(app.server.path))),
      uptime: (performance.now() - started) / 1000,
    }),
  });
}

export function startAdmin(
  app: App,
  path = adminSocket(),
  lifetime?: ServerLifetime,
) {
  return startAdminHandler(adminHandler(app), path, lifetime);
}
