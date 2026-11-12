// One fresh app/store and real loopback listener per HTTP test file.
import { pathfinder } from '@pathfinder/pathfinder';
import { closeApp, openApp } from '#engine/app.ts';
import { registerUser } from '#engine/tenant/users.ts';
import { assertSpecHttpResponse } from '#tests/spec-contract.ts';

/** Preserve old test cases as named steps, sharing one fresh store per
 * file and closing all resources within the enclosing test. */
export function httpSuite(name: string, roots?: string[]) {
  const cases: { name: string; fn: () => Promise<void> }[] = [];
  let http: Awaited<ReturnType<typeof startHttp>>;
  Deno.test(name, async (t) => {
    http = await startHttp(roots);
    try {
      for (const test of cases) await t.step(test.name, test.fn);
    } finally {
      await http.close();
    }
  });
  return {
    test: (name: string, fn: () => Promise<void>) => cases.push({ name, fn }),
    matrix: (request: Request) => http.matrix(request),
    registerTestUser: (localpart: string, password: string) =>
      http.registerTestUser(localpart, password),
  };
}

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
      matrix: async (request: Request) => {
        const url = new URL(request.url);
        const response = await fetch(
          new Request(base + url.pathname + url.search, request),
        );
        await assertSpecHttpResponse(request, response);
        return response;
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
