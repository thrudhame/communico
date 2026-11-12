// Matrix appendix server-name grammar, not WHATWG URL normalization. Keep the
// original identity spelling for Host and signatures; return only dial parts.
import { isIP } from 'node:net';
import { parseIp } from '#engine/preview/cidr.ts';
import { protocol } from '#engine/net/upstream-error.ts';

export function isIpLiteral(host: string): boolean {
  return isIP(host) !== 0 || parseIp(host) !== null;
}
export function splitServerName(
  name: string,
): { host: string; port: number | null } {
  let host: string, suffix: string;
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    host = name.slice(1, end);
    suffix = name.slice(end + 1);
    if (end < 0 || isIP(host) !== 6) {
      protocol('server-name', 'invalid IPv6 server name');
    }
  } else {
    const colon = name.indexOf(':');
    host = colon < 0 ? name : name.slice(0, colon);
    suffix = colon < 0 ? '' : name.slice(colon);
    if (!/^[A-Za-z0-9.-]{1,255}$/.test(host)) {
      protocol('server-name', 'invalid server hostname');
    }
    if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(host) && parseIp(host) === null) {
      protocol('server-name', 'invalid IPv4 server name');
    }
  }
  if (!suffix) return { host, port: null };
  if (!/^:\d{1,5}$/.test(suffix)) {
    protocol('server-name', 'invalid server port');
  }
  const port = Number(suffix.slice(1));
  if (port < 1 || port > 65535) {
    protocol('server-name', 'server port out of range');
  }
  return { host, port };
}
