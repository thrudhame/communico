// Shared transport boundary: unpaired nodes need no tenant to bind local admin.
import { dirname } from '@std/path';
import { adminSocket, validateAdminSocketPath } from '#engine/config.ts';
import type { ServerLifetime } from '#root/api/server-lifetime.ts';

/** Bind synchronously under a restrictive umask, verify before serving work. */
export async function startAdminHandler(
  handler: (request: Request) => Promise<Response>,
  path = adminSocket(),
  lifetime?: ServerLifetime,
) {
  path = validateAdminSocketPath(path);
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
    server = Deno.serve({
      transport: 'unix',
      path,
      signal: lifetime?.controller.signal,
      onListen() {},
    }, lifetime ? lifetime.wrap('admin', handler) : handler);
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
