// One fresh app/store and real loopback listener per HTTP test file.
import { pathfinder } from '@pathfinder/pathfinder';
import { closeApp, openApp } from '#engine/app.ts';
import { registerUser } from '#engine/tenant/users.ts';

export async function startHttp(roots = ['api/endpoints/matrix/']) {
  const dir = await Deno.makeTempDir({ prefix: 'http-app-' });
  const app = await openApp({
    dir,
    library: './.native/libturso_ffi.so',
    checkpointlogbytes: 65536,
    maxopenfiles: 8,
    idleseconds: 300,
  });
  try {
    const handler = await pathfinder({ roots });
    const server = Deno.serve({
      hostname: '127.0.0.1',
      port: 0,
      onListen: () => {},
    }, handler);
    const base = `http://127.0.0.1:${server.addr.port}`;
    return {
      app,
      // Keep the old matrix(Request) call shape, but observe real HTTP.
      matrix: (request: Request) => {
        const url = new URL(request.url);
        return fetch(new Request(base + url.pathname + url.search, request));
      },
      registerTestUser: (localpart: string, password: string) =>
        registerUser(app.tenant, { localpart, password }),
      close: async () => {
        await server.shutdown();
        await closeApp();
        await Deno.remove(dir, { recursive: true });
      },
    };
  } catch (error) {
    await closeApp();
    await Deno.remove(dir, { recursive: true });
    throw error;
  }
}
