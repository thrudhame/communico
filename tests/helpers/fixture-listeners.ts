// Child listeners select their own ephemeral ports and publish live bindings.
// Never probe and release a port in the parent: there is no reservation to race.
import { Server } from 'node:net';
import { parse, stringify } from '@std/toml';
import { config } from '#engine/config.ts';

type Listener = 'client' | 'federation' | 'link';
const variable = 'DENO_COMMUNICO_TEST_LISTENERS';

export async function fixtureLink(config: string, port: number) {
  const text = await Deno.readTextFile(config);
  await Deno.writeTextFile(
    config,
    text.replace(
      /url="https:\/\/127\.0\.0\.1:\d+"/,
      `url="https://127.0.0.1:${port}"`,
    ),
  );
}

async function rememberPort(config: string, name: Listener, port: number) {
  const section = name === 'client'
    ? 'server'
    : name === 'link'
    ? 'facade'
    : 'federation';
  const field = name === 'link' ? 'linkport' : 'port';
  const text = await Deno.readTextFile(config);
  const pattern = new RegExp(`(\\[${section}\\][^\\[]*?\\n${field}=)\\d+`);
  await Deno.writeTextFile(config, text.replace(pattern, `$1${port}`));
  if (name === 'link') await fixtureLink(config, port);
}

export async function fixtureListeners(config: string) {
  const path = config + '.listeners-' + crypto.randomUUID();
  await Deno.writeTextFile(path, '');
  return {
    env: { [variable]: path },
    async port(name: Listener): Promise<number> {
      const deadline = Date.now() + 20000;
      for (;;) {
        const lines = (await Deno.readTextFile(path)).split('\n').filter(
          Boolean,
        );
        for (const line of lines) {
          const binding = JSON.parse(line);
          if (binding.name === name) {
            // Returning a binding also establishes the fixture's restart
            // address. Every consumer gets the same post-bind contract.
            await rememberPort(config, name, binding.port);
            return binding.port;
          }
        }
        if (Date.now() >= deadline) {
          throw new Error('child listener deadline: ' + name);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
  };
}

export function observeFixtureListeners() {
  const path = Deno.env.get(variable);
  if (!path) return;
  const record = (name: Listener, port: number) => {
    Deno.writeTextFileSync(path, JSON.stringify({ name, port }) + '\n', {
      append: true,
    });
  };
  Deno.serve = new Proxy(Deno.serve, {
    apply(serve, receiver, args) {
      const server = Reflect.apply(serve, receiver, args);
      if ('port' in server.addr) {
        record(args[0]?.cert ? 'federation' : 'client', server.addr.port);
      }
      return server;
    },
  });
  Server.prototype.listen = new Proxy(Server.prototype.listen, {
    apply(listen, server, args) {
      server.once('listening', () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          // The runtime captured this settings object before starting its TLS
          // listener. Resolve the fixture's zero URL at the binding boundary,
          // before enrollment can compare its transcript with those settings.
          const settings = config().facade;
          if (settings.linkport === 0 && settings.url.endsWith(':0')) {
            Object.assign(settings, {
              linkport: address.port,
              url: settings.url.replace(/:0$/, ':' + address.port),
            });
          }
          record('link', address.port);
        }
      });
      return Reflect.apply(listen, server, args);
    },
  });
}

// The HTTP federation loop names the homeserver after its real TLS endpoint.
// Break that bootstrap dependency by retaining the already-bound listener and
// handing the very same server to main when it installs the route handler.
export async function prepareFixtureServerName() {
  const path = Deno.env.get('COMMUNICO_CONFIG');
  if (!path) return;
  const document = parse(await Deno.readTextFile(path));
  const server = document.server as Record<string, unknown> | undefined;
  const federation = document.federation as Record<string, unknown> | undefined;
  if (!server || !federation || !String(server.name).endsWith(':0')) return;
  if (federation.port !== 0) {
    throw new Error('named fixture must bind port zero');
  }
  const installed = Promise.withResolvers<Deno.ServeHandler>();
  const listener = Deno.serve({
    hostname: '127.0.0.1',
    port: 0,
    cert: await Deno.readTextFile(String(federation.cert)),
    key: await Deno.readTextFile(String(federation.key)),
    onListen() {},
  }, async (request, info) => (await installed.promise)(request, info));
  federation.port = listener.addr.port;
  server.name = String(server.name).replace(/:0$/, ':' + listener.addr.port);
  await Deno.writeTextFile(path, stringify(document));
  const serve = Deno.serve;
  Deno.serve = new Proxy(serve, {
    apply(target, receiver, args) {
      if (args[0]?.port !== listener.addr.port) {
        return Reflect.apply(target, receiver, args);
      }
      installed.resolve(args[1]);
      args[0].signal?.addEventListener(
        'abort',
        () => void listener.shutdown(),
        { once: true },
      );
      return listener;
    },
  });
}
