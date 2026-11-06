// Local-only composition root. Public Matrix listeners never mount this handler.
import { dirname, resolve } from '@std/path';
import type { App } from '#engine/app.ts';
import { adminSocket, serverName } from '#engine/config.ts';
import metadata from '#root/deno.json' with { type: 'json' };

export class AdminError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export type Operation = (
  body: Record<string, unknown>,
) => Promise<unknown> | unknown;

export function adminHandler(
  app: App,
): (request: Request) => Promise<Response> {
  const started = performance.now();
  const operations: Record<string, Operation> = {
    '/v1/status': () => ({
      server: serverName(),
      version: metadata.version,
      store: resolve(dirname(dirname(app.server.path))),
      uptime: (performance.now() - started) / 1000,
    }),
  };
  return async (request) => {
    try {
      const path = new URL(request.url).pathname;
      if (!Object.hasOwn(operations, path)) {
        throw new AdminError('NOT_FOUND', 'unknown admin operation', 404);
      }
      if (request.method !== 'POST') {
        throw new AdminError('METHOD_NOT_ALLOWED', 'use POST', 405);
      }
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        throw new AdminError('BAD_REQUEST', 'expected a JSON object');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new AdminError('BAD_REQUEST', 'expected a JSON object');
      }
      return Response.json({
        ok: true,
        result: await operations[path](body as Record<string, unknown>),
      });
    } catch (error) {
      const known = error instanceof AdminError;
      if (!known) console.error('admin:', error);
      return Response.json({
        ok: false,
        error: {
          code: known ? error.code : 'INTERNAL',
          message: known ? error.message : 'admin operation failed',
        },
      }, { status: known ? error.status : 500 });
    }
  };
}

/** Bind synchronously under a restrictive umask, verify before serving work. */
export async function startAdmin(app: App, path = adminSocket()) {
  const parent = await Deno.lstat(dirname(path));
  const uid = Deno.uid();
  if (!parent.isDirectory || parent.uid !== uid) {
    throw new Error(
      `admin socket parent must be owned by the server user: ${dirname(path)}`,
    );
  }
  let existing: Deno.FileInfo | null = null;
  try {
    existing = await Deno.lstat(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  if (existing !== null) {
    if (!existing.isSocket || existing.uid !== uid) {
      throw new Error(`refusing to remove non-owned socket path: ${path}`);
    }
    try {
      const connection = await Deno.connect({ transport: 'unix', path });
      connection.close();
    } catch (error) {
      if (!(error instanceof Deno.errors.ConnectionRefused)) throw error;
      const now = await Deno.lstat(path);
      if (now.ino !== existing.ino || now.dev !== existing.dev) {
        throw new Error(`admin socket changed during stale check: ${path}`);
      }
      await Deno.remove(path);
      existing = null;
    }
    if (existing !== null) {
      throw new Error(`another server owns this store: ${path}`);
    }
  }
  const mask = Deno.umask(0o177);
  let server: Deno.HttpServer<Deno.UnixAddr>;
  try {
    server = Deno.serve(
      { transport: 'unix', path, onListen() {} },
      adminHandler(app),
    );
  } finally {
    Deno.umask(mask);
  }
  const bound = await Deno.lstat(path);
  if (
    !bound.isSocket || bound.uid !== uid || (bound.mode! & 0o7777) !== 0o600
  ) {
    await server.shutdown();
    throw new Error(
      `admin socket must be owned by the server user with mode 0600: ${path}`,
    );
  }
  return {
    path,
    async shutdown() {
      await server.shutdown();
      try {
        const current = await Deno.lstat(path);
        if (current.ino === bound.ino && current.dev === bound.dev) {
          await Deno.remove(path);
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    },
  };
}
