// Keep real TLS, HTTP, signatures and link authorization. Replace only fixture
// DNS, the address reported by the incoming TLS socket, and final socket routing.
import tls from 'node:tls';
import { Server } from 'node:https';
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

await import('./facade-child.ts');
