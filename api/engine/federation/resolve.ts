// api/engine/federation/resolve.ts — the server-name resolution ladder
// (SS:97-218). Order: (0) a roster row supplies TRUST whatever the
// address source; its host/port override is WHERE to connect, never the
// identity (the cert is verified for the server name); a keyname row
// without an address is a 502, and a key-is-name with no row is a 502 —
// never the DNS ladder. (1) IP literal → direct, sni null (RFC 6066 §3).
// (2) hostname:port → A/AAAA. (3) bare hostname → .well-known with
// cache-by-Cache-Control (errors remembered for wellknownerrorhours),
// its m.server going through sub-ladder 3.1–3.5. (4) no .well-known →
// SRV _matrix-fed._tcp, legacy _matrix._tcp, then <host>:8448. No policy
// inside — the admission gate runs in the callers. Deps are injected so
// the ladder is unit-tested without network or DB; the production
// resolve() takes the server file's Db for the roster lookup.
// Ported from doltgres; one repair: the well-known fetch reads the
// configured cacerts FILES (the old code passed the paths as PEM).
import { config } from '#engine/config.ts';
import { http1Request } from '#engine/net/http1.ts';
import { parseIp } from '#engine/preview/cidr.ts';
import { b32decode, isKeyName } from '#engine/signing-primitives.js';
import { MatrixError } from '#engine/matrix-error.ts';
import { lookupPeer, type PeerRow } from './peers.ts';
import type { Database as Db } from '#engine/store/db.ts';

export type Trust =
  | { kind: 'ca' }
  | { kind: 'pinned'; spkiSha256: string }
  | { kind: 'keyname'; pubkey: Uint8Array };

export type Endpoint = {
  connectIp: string;
  port: number;
  hostHeader: string;
  sni: string | null;
  trust: Trust;
};

export type ResolveDeps = {
  dnsA: (host: string) => Promise<string[]>;
  dnsAAAA: (host: string) => Promise<string[]>;
  dnsSrv: (
    host: string,
  ) => Promise<
    { target: string; port: number; priority: number; weight: number }[]
  >;
  wellKnownGet: (
    host: string,
  ) => Promise<{ mServer: string | null; maxAgeMs: number | null }>;
  lookupPeer: (name: string) => Promise<PeerRow | null>;
};

async function defaultDns(host: string, type: 'A' | 'AAAA'): Promise<string[]> {
  try {
    const r = await Deno.resolveDns(host, type);
    return r.map((x: unknown) =>
      typeof x === 'string' ? x : String((x as Record<string, unknown>).addr)
    );
  } catch {
    return [];
  }
}

async function defaultSrv(
  host: string,
): Promise<
  { target: string; port: number; priority: number; weight: number }[]
> {
  try {
    const r = await Deno.resolveDns(host, 'SRV');
    return r.map((x: unknown) => {
      const o = x as {
        target: string;
        port: number;
        priority: number;
        weight: number;
      };
      return {
        target: o.target,
        port: o.port,
        priority: o.priority,
        weight: o.weight,
      };
    });
  } catch {
    return [];
  }
}

// The extra CA bundles for outbound TLS: PEM paths in the config, PEM
// content here, read once at startup (the client shares this loader).
let _cacertsPem: string[] | null = null;

export function caCertsPem(): string[] {
  if (_cacertsPem !== null) return _cacertsPem;
  _cacertsPem = config().federation.cacerts.map((p) =>
    Deno.readTextFileSync(p)
  );
  return _cacertsPem;
}

/** Tests setConfigForTests after the first read — drop the memo. */
export function resetCaCertsForTests(): void {
  _cacertsPem = null;
}

// .well-known answers and failures are cached in-memory with the
// configured horizons; a module-level cache, resettable for tests.
const wellKnownCache = new Map<
  string,
  {
    answer: { mServer: string | null; maxAgeMs: number | null } | 'error';
    expiresMs: number;
  }
>();

export function resetWellKnownCache(): void {
  wellKnownCache.clear();
}

async function defaultWellKnownGet(
  host: string,
): Promise<{ mServer: string | null; maxAgeMs: number | null }> {
  const now = Date.now();
  const hit = wellKnownCache.get(host);
  if (hit !== undefined && hit.expiresMs > now) {
    return hit.answer === 'error'
      ? { mServer: null, maxAgeMs: null }
      : hit.answer;
  }
  const fed = config().federation;
  let answer: { mServer: string | null; maxAgeMs: number | null } | 'error';
  try {
    const ips = [
      ...(await defaultDns(host, 'A')),
      ...(await defaultDns(host, 'AAAA')),
    ];
    if (ips.length === 0) throw new MatrixError(502, 'M_UNKNOWN', 'no address');
    let url = 'https://' + host + '/.well-known/matrix/server';
    let hops = 0;
    while (true) {
      const parsed = new URL(url);
      const hopIps = [
        ...(await defaultDns(parsed.hostname, 'A')),
        ...(await defaultDns(parsed.hostname, 'AAAA')),
      ];
      if (hopIps.length === 0) {
        throw new MatrixError(502, 'M_UNKNOWN', 'no address');
      }
      const port = parsed.port === '' ? 443 : Number(parsed.port);
      const res = await http1Request({
        connectIp: hopIps[0],
        port,
        tls: { sni: parsed.hostname, caCerts: caCertsPem() },
        hostHeader: port === 443
          ? parsed.hostname
          : parsed.hostname + ':' + port,
        method: 'GET',
        path: parsed.pathname,
        headers: { Accept: 'application/json' },
        body: null,
        connectMs: fed.connectms,
        timeoutMs: fed.timeoutms,
        maxBytes: fed.maxbytes,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (loc === null) throw new MatrixError(502, 'M_UNKNOWN', 'redirect');
        hops++;
        if (hops > 5) {
          throw new MatrixError(502, 'M_UNKNOWN', 'too many redirects');
        }
        url = new URL(loc, parsed).href;
        continue;
      }
      if (res.status !== 200) {
        throw new MatrixError(
          502,
          'M_UNKNOWN',
          'well-known returned ' + res.status,
        );
      }
      const body = JSON.parse(new TextDecoder().decode(res.body)) as Record<
        string,
        unknown
      >;
      const cc = res.headers.get('cache-control');
      const m = cc !== null ? /max-age=(\d+)/.exec(cc) : null;
      const maxAgeMs = m !== null ? Number(m[1]) * 1000 : null;
      answer = {
        mServer: typeof body['m.server'] === 'string'
          ? body['m.server'] as string
          : null,
        maxAgeMs,
      };
      break;
    }
  } catch {
    answer = 'error';
  }
  const fed2 = config().federation;
  wellKnownCache.set(host, {
    answer,
    expiresMs: now +
      (answer === 'error'
        ? fed2.wellknownerrorhours * 3600_000
        : (answer.maxAgeMs === null
          ? fed2.wellknownhours * 3600_000
          : Math.min(answer.maxAgeMs, fed2.wellknownmaxhours * 3600_000))),
  });
  return answer === 'error' ? { mServer: null, maxAgeMs: null } : answer;
}

function trustOf(row: PeerRow): Trust {
  if (row.trust === 'pinned' && row.pin_spki_sha256 !== null) {
    return { kind: 'pinned', spkiSha256: row.pin_spki_sha256 };
  }
  if (row.trust === 'keyname') {
    const pubkey = b32decode(row.name);
    if (pubkey === null) {
      throw new MatrixError(502, 'M_UNKNOWN', 'bad keyname roster name');
    }
    return { kind: 'keyname', pubkey };
  }
  return { kind: 'ca' };
}

// <name> split into host + optional port — handles [v6]:port and v4/name:port
export function splitServerName(
  name: string,
): { host: string; port: number | null } {
  if (name.startsWith('[')) {
    const end = name.indexOf(']');
    if (end > 0) {
      const host = name.slice(1, end);
      const rest = name.slice(end + 1);
      if (rest.startsWith(':')) {
        const port = Number(rest.slice(1));
        return { host, port: Number.isInteger(port) ? port : null };
      }
      return { host, port: null };
    }
  }
  const idx = name.lastIndexOf(':');
  if (idx > 0 && name.indexOf(':') === idx) {
    const port = Number(name.slice(idx + 1));
    if (Number.isInteger(port)) return { host: name.slice(0, idx), port };
  }
  return { host: name, port: null };
}

export async function resolveWith(
  name: string,
  deps: ResolveDeps,
): Promise<Endpoint> {
  // (0) roster row: trust comes from the row whatever the address source
  const row = await deps.lookupPeer(name);
  const trust = row !== null ? trustOf(row) : { kind: 'ca' } as Trust;
  const nameHost = splitServerName(name).host;
  const sniOf = parseIp(nameHost) === null ? nameHost : null;
  if (isKeyName(name)) {
    if (row === null || row.host === null || row.port === null) {
      throw new MatrixError(
        502,
        'M_UNKNOWN',
        `key-is-name peer ${name} has no address`,
      );
    }
    const ips = await resolveHost(row.host, deps);
    return {
      connectIp: ips[0],
      port: row.port,
      hostHeader: name,
      sni: sniOf,
      trust,
    };
  }
  if (row !== null && row.host !== null && row.port !== null) {
    const ips = await resolveHost(row.host, deps);
    return {
      connectIp: ips[0],
      port: row.port,
      hostHeader: name,
      sni: sniOf,
      trust,
    };
  }

  const trustDefault = trust;
  const { host, port } = splitServerName(name);
  // (1) IP literal
  const literal = parseIp(host);
  if (literal !== null) {
    return {
      connectIp: host,
      port: port !== null ? port : 8448,
      hostHeader: name,
      sni: null,
      trust: trustDefault,
    };
  }
  // (2) explicit port
  if (port !== null) {
    const ips = await resolveHost(host, deps);
    return {
      connectIp: ips[0],
      port,
      hostHeader: name,
      sni: host,
      trust: trustDefault,
    };
  }
  // (3) .well-known
  const wk = await deps.wellKnownGet(host);
  if (wk.mServer !== null) {
    const delegated = splitServerName(wk.mServer);
    const delegatedLiteral = parseIp(delegated.host);
    if (delegatedLiteral !== null) {
      return {
        connectIp: delegated.host,
        port: delegated.port !== null ? delegated.port : 8448,
        hostHeader: wk.mServer,
        sni: null,
        trust: trustDefault,
      };
    }
    if (delegated.port !== null) {
      const ips = await resolveHost(delegated.host, deps);
      return {
        connectIp: ips[0],
        port: delegated.port,
        hostHeader: wk.mServer,
        sni: delegated.host,
        trust: trustDefault,
      };
    }
    const bySrv = await resolveSrv(delegated.host, deps);
    if (bySrv !== null) {
      return {
        connectIp: bySrv.ip,
        port: bySrv.port,
        hostHeader: delegated.host +
          (bySrv.port === 8448 ? '' : ':' + bySrv.port),
        sni: delegated.host,
        trust: trustDefault,
      };
    }
    return {
      connectIp: (await resolveHost(delegated.host, deps))[0],
      port: 8448,
      hostHeader: delegated.host,
      sni: delegated.host,
      trust: trustDefault,
    };
  }
  // (4) SRV, then <host>:8448
  const bySrv = await resolveSrv(host, deps);
  if (bySrv !== null) {
    return {
      connectIp: bySrv.ip,
      port: bySrv.port,
      hostHeader: name + (bySrv.port === 8448 ? '' : ''),
      sni: host,
      trust: trustDefault,
    };
  }
  const ips = await resolveHost(host, deps);
  return {
    connectIp: ips[0],
    port: 8448,
    hostHeader: name,
    sni: host,
    trust: trustDefault,
  };
}

async function resolveHost(host: string, deps: ResolveDeps): Promise<string[]> {
  const viaA = await deps.dnsA(host);
  if (viaA.length > 0) return viaA;
  const viaAAAA = await deps.dnsAAAA(host);
  if (viaAAAA.length > 0) return viaAAAA;
  const literal = parseIp(host);
  if (literal !== null) return [host];
  throw new MatrixError(502, 'M_UNKNOWN', `could not resolve ${host}`);
}

// SRV: _matrix-fed._tcp, then legacy _matrix._tcp — lowest priority, then
// highest weight (simple sorted pick; documented, not randomised).
async function resolveSrv(
  host: string,
  deps: ResolveDeps,
): Promise<{ ip: string; port: number } | null> {
  for (const label of ['_matrix-fed._tcp.', '_matrix._tcp.']) {
    const rows = await deps.dnsSrv(label + host);
    if (rows.length === 0) continue;
    const sorted = [...rows].sort(
      (a, b) => a.priority - b.priority || b.weight - a.weight,
    );
    const ips = await resolveHost(sorted[0].target, deps);
    return { ip: ips[0], port: sorted[0].port };
  }
  return null;
}

// The production ladder: DNS + the cached .well-known fetch + the roster
// in the server file.
export async function resolve(server: Db, name: string): Promise<Endpoint> {
  const deps: ResolveDeps = {
    dnsA: (h) => defaultDns(h, 'A'),
    dnsAAAA: (h) => defaultDns(h, 'AAAA'),
    dnsSrv: defaultSrv,
    wellKnownGet: defaultWellKnownGet,
    lookupPeer: (n) => lookupPeer(server, n),
  };
  return await resolveWith(name, deps);
}
