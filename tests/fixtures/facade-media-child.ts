// Keep real TLS, HTTP, signatures and link authorization. Route fixture sockets
// locally and observe the real cache's waiters and serving lease.
import tls from 'node:tls';
import { Server } from 'node:https';
import { MediaCache } from '#engine/media/cache.ts';
import { beforeFacadePublication } from '#tests/helpers/facade-process.ts';
import { mediaDemand } from '#tests/support/media-demand.ts';
import {
  homeIp,
  mappedHome,
  peerIp,
} from '#tests/support/facade-media-wire.ts';

const ledger = Deno.env.get('COMMUNICO_CONFIG')! + '.connects';
const testAddress = (host: string) =>
  [peerIp, homeIp, mappedHome, '10.0.0.1', '11.0.0.1'].includes(host);
const route = (host: string) => {
  Deno.writeTextFileSync(ledger, host + '\n', { append: true });
  return '127.0.0.1';
};
Deno.resolveDns = new Proxy(Deno.resolveDns, {
  apply(resolve, receiver, args) {
    const [host, type] = args;
    if (host === 'localhost' || host === 'logical.test') {
      return Promise.resolve(type === 'A' ? [peerIp] : []);
    }
    if (host === 'mixed.test') {
      return Promise.resolve(type === 'A' ? [peerIp, homeIp] : []);
    }
    if (host === 'home.test') {
      return Promise.resolve(type === 'A' ? [homeIp] : []);
    }
    return Reflect.apply(resolve, receiver, args);
  },
});
tls.connect = new Proxy(tls.connect, {
  apply(connect, receiver, args) {
    const options = args[0];
    if (options?.host && testAddress(options.host)) {
      args[0] = { ...options, host: route(options.host) };
    }
    return Reflect.apply(connect, receiver, args);
  },
});
Deno.connect = new Proxy(Deno.connect, {
  apply(connect, receiver, args) {
    const options = args[0];
    if (options.hostname && testAddress(options.hostname)) {
      args[0] = { ...options, hostname: route(options.hostname) };
    }
    return Reflect.apply(connect, receiver, args);
  },
});
const listen = Server.prototype.listen;
Server.prototype.listen = new Proxy(listen, {
  apply(listen, server, args) {
    server.prependListener('secureConnection', (socket: tls.TLSSocket) => {
      Object.defineProperty(socket, 'remoteAddress', { value: mappedHome });
    });
    return Reflect.apply(listen, server, args);
  },
});

const holds: string[] = JSON.parse(Deno.env.get('FACADE_TEST_HOLDS') ?? '[]');
if (holds.includes('media-joined')) {
  const demand = mediaDemand();
  void demand.joined.then(() => beforeFacadePublication('media-joined'));
  void demand.firstLeft.then(() => beforeFacadePublication('media-left'));
  const open = MediaCache.prototype.open;
  MediaCache.prototype.open = async function (row) {
    const stream = await open.call(this, row);
    // Keep the real lease live, without taking the cache's serialized lane.
    if (row.media_id === 'cache-leased') {
      await beforeFacadePublication('media-lease');
    }
    return stream;
  };
}

await import('./facade-child.ts');
