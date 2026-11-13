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
import { b32decode, isKeyName } from '#engine/signing-primitives.js';
import { MatrixError } from '#engine/matrix-error.ts';
import { lookupPeer, type PeerRow } from './peers.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { abortable } from '#engine/net/abort.ts';
import {
  protocol,
  recoverableUpstream,
  upstreamCategory,
  UpstreamError,
} from '#engine/net/upstream-error.ts';
import { isIpLiteral, splitServerName } from './server-name.ts';
import { wellKnownGet } from './well-known.ts';
export { splitServerName } from './server-name.ts';
export { resetWellKnownCache } from './well-known.ts';

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
  alternatives?: AsyncIterable<{ connectIp: string; port: number }>;
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
  random?: () => number;
};

async function defaultDns(
  host: string,
  type: 'A' | 'AAAA',
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const r = await abortable(
      signal,
      () => Deno.resolveDns(host, type, { signal }),
    );
    return r;
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof Deno.errors.NotFound) return [];
    throw new UpstreamError('transport', {
      phase: 'dns',
      reason: 'DNS address query failed',
      cause,
    });
  }
}

async function defaultSrv(
  host: string,
  signal?: AbortSignal,
): Promise<
  { target: string; port: number; priority: number; weight: number }[]
> {
  try {
    const r = await abortable(
      signal,
      () => Deno.resolveDns(host, 'SRV', { signal }),
    );
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
  } catch (cause) {
    signal?.throwIfAborted();
    if (cause instanceof Deno.errors.NotFound) return [];
    throw new UpstreamError('transport', {
      phase: 'dns',
      reason: 'DNS service query failed',
      cause,
    });
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

async function defaultWellKnownGet(
  host: string,
  signal?: AbortSignal,
): Promise<{ mServer: string | null; maxAgeMs: number | null }> {
  return await wellKnownGet(
    host,
    (name) =>
      resolveHost(name, {
        dnsA: (h) => defaultDns(h, 'A', signal),
        dnsAAAA: (h) => defaultDns(h, 'AAAA', signal),
      }, signal),
    caCertsPem,
    signal,
  );
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

export async function resolveWith(
  name: string,
  deps: ResolveDeps,
  signal?: AbortSignal,
): Promise<Endpoint> {
  const source = deps;
  deps = {
    dnsA: (h) => abortable(signal, () => source.dnsA(h)),
    dnsAAAA: (h) => abortable(signal, () => source.dnsAAAA(h)),
    dnsSrv: (h) => abortable(signal, () => source.dnsSrv(h)),
    wellKnownGet: (h) => abortable(signal, () => source.wellKnownGet(h)),
    lookupPeer: (n) => abortable(signal, () => source.lookupPeer(n)),
    random: source.random,
  };
  // (0) roster row: trust comes from the row whatever the address source
  const row = await deps.lookupPeer(name);
  const trust = row !== null ? trustOf(row) : { kind: 'ca' } as Trust;
  const { host, port } = splitServerName(name);
  const sniOf = isIpLiteral(host) ? null : host;
  if (isKeyName(name)) {
    if (row === null || row.host === null || row.port === null) {
      throw new MatrixError(
        502,
        'M_UNKNOWN',
        `key-is-name peer ${name} has no address`,
      );
    }
    return endpoint(
      hostAddresses(row.host, row.port, deps, signal),
      name,
      sniOf,
      trust,
    );
  }
  if (row !== null && row.host !== null && row.port !== null) {
    return endpoint(
      hostAddresses(row.host, row.port, deps, signal),
      name,
      sniOf,
      trust,
    );
  }

  // (1) IP literal
  if (isIpLiteral(host)) {
    return endpoint(
      [{ ip: host, port: port !== null ? port : 8448 }],
      name,
      null,
      trust,
    );
  }
  // (2) explicit port
  if (port !== null) {
    return endpoint(hostAddresses(host, port, deps, signal), name, host, trust);
  }
  // (3) .well-known
  let delegation: string | null = null;
  try {
    const wk = await deps.wellKnownGet(host);
    if (wk.mServer !== null) {
      splitServerName(wk.mServer);
      delegation = wk.mServer;
    }
  } catch (error) {
    discoveryFallback(error, signal);
  }
  const target = delegation === null
    ? { host, port: null }
    : splitServerName(delegation);
  const identity = delegation === null ? name : delegation;
  if (isIpLiteral(target.host)) {
    return endpoint(
      [{ ip: target.host, port: target.port === null ? 8448 : target.port }],
      identity,
      null,
      trust,
    );
  }
  if (target.port !== null) {
    const targetPort = target.port;
    return endpoint(
      hostAddresses(target.host, targetPort, deps, signal),
      identity,
      target.host,
      trust,
    );
  }
  // An SRV port changes the dial target, never the delegated Host/TLS identity.
  const bySrv = await resolveSrv(target.host, deps, signal);
  if (bySrv !== null) {
    return endpoint(bySrv, identity, target.host, trust);
  }
  return endpoint(
    hostAddresses(target.host, 8448, deps, signal),
    identity,
    target.host,
    trust,
  );
}

async function endpoint(
  addresses:
    | Iterable<{ ip: string; port: number }>
    | AsyncIterable<{ ip: string; port: number }>,
  hostHeader: string,
  sni: string | null,
  trust: Trust,
): Promise<Endpoint> {
  const remaining = (async function* () {
    yield* addresses;
  })();
  const next = await remaining.next();
  if (next.done) {
    throw new UpstreamError('transport', {
      phase: 'dns',
      reason: 'no eligible server address',
    });
  }
  const first = next.value;
  return {
    connectIp: first.ip,
    port: first.port,
    hostHeader,
    sni,
    trust,
    alternatives: (async function* () {
      for await (const { ip, port } of remaining) yield { connectIp: ip, port };
    })(),
  };
}

function discoveryFallback(error: unknown, signal?: AbortSignal): void {
  signal?.throwIfAborted();
  if (
    upstreamCategory(error, signal) === 'cancellation' ||
    !recoverableUpstream(error, signal)
  ) throw error;
}

async function* resolveHost(
  host: string,
  deps: Pick<ResolveDeps, 'dnsA' | 'dnsAAAA'>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (isIpLiteral(host)) {
    yield host;
    return;
  }
  // Neither address family waits for the other. Keep the unconsumed answer
  // available for connection failover, with every rejection observed immediately.
  const queries = new Map(
    [deps.dnsA, deps.dnsAAAA].map((
      query,
      index,
    ) => [
      index,
      Promise.resolve().then(() => query(host)).then(
        (addresses) => ({ index, addresses, error: undefined }),
        (error: unknown) => ({ index, addresses: [] as string[], error }),
      ),
    ]),
  );
  const seen = new Set<string>();
  while (queries.size) {
    const result = await abortable(
      signal,
      () => Promise.race(queries.values()),
    );
    queries.delete(result.index);
    try {
      if (result.error !== undefined) throw result.error;
      for (const address of result.addresses) {
        if (typeof address !== 'string' || !isIpLiteral(address)) {
          protocol('dns', 'invalid address answer');
        }
      }
      for (const address of result.addresses) {
        if (!seen.has(address)) {
          seen.add(address);
          yield address;
        }
      }
    } catch (error) {
      discoveryFallback(error, signal);
    }
  }
  if (seen.size) return;
  throw new UpstreamError('transport', {
    phase: 'dns',
    reason: 'could not resolve server hostname',
  });
}

async function* hostAddresses(
  host: string,
  port: number,
  deps: Pick<ResolveDeps, 'dnsA' | 'dnsAAAA'>,
  signal?: AbortSignal,
) {
  for await (const ip of resolveHost(host, deps, signal)) yield { ip, port };
}

// RFC2782: increasing priority, weighted draws without replacement within each
// priority. Zero weights lead the cumulative list and retain a chance at draw0.
function srvOrder(
  rows: Awaited<ReturnType<ResolveDeps['dnsSrv']>>,
  random: () => number,
) {
  const result: typeof rows = [];
  const priorities = [...new Set(rows.map((r) => r.priority))].sort((a, b) =>
    a - b
  );
  for (const priority of priorities) {
    const remaining = rows.filter((r) => r.priority === priority).sort((a, b) =>
      Number(a.weight !== 0) - Number(b.weight !== 0)
    );
    while (remaining.length) {
      const sum = remaining.reduce((n, r) => n + r.weight, 0);
      let index: number;
      if (sum > 0) {
        const draw = Math.floor(random() * (sum + 1));
        let running = 0;
        index = remaining.findIndex((r) => {
          running += r.weight;
          return running >= draw;
        });
      } else index = Math.floor(random() * remaining.length);
      result.push(remaining.splice(index, 1)[0]);
    }
  }
  return result;
}

async function resolveSrv(
  host: string,
  deps: ResolveDeps,
  signal?: AbortSignal,
): Promise<AsyncIterable<{ ip: string; port: number }> | null> {
  for (const label of ['_matrix-fed._tcp.', '_matrix._tcp.']) {
    let rows: Awaited<ReturnType<ResolveDeps['dnsSrv']>>;
    try {
      rows = await deps.dnsSrv(label + host);
    } catch (error) {
      discoveryFallback(error, signal);
      continue;
    }
    if (rows.length === 0) continue;
    if (rows.length === 1 && rows[0].target === '.') {
      throw new UpstreamError('transport', {
        phase: 'dns',
        reason: 'federation service is unavailable',
      });
    }
    for (const row of rows) {
      if (
        ![row.port, row.priority, row.weight].every((n) =>
          Number.isInteger(n) && n >= 0 && n <= 65535
        ) || typeof row.target !== 'string' || row.target === '.'
      ) protocol('dns', 'invalid SRV answer');
      const target = splitServerName(row.target.replace(/\.$/, ''));
      if (target.port !== null || isIpLiteral(target.host)) {
        protocol('dns', 'invalid SRV target');
      }
    }
    const ordered = srvOrder(
      rows,
      deps.random === undefined ? Math.random : deps.random,
    );
    return (async function* () {
      let yielded = false;
      const sources = ordered.map((row) =>
        hostAddresses(row.target.replace(/\.$/, ''), row.port, deps, signal)
      );
      type Answer = {
        index: number;
        result?: IteratorResult<{ ip: string; port: number }>;
        error?: unknown;
      };
      const pending = new Map<number, Promise<Answer>>();
      const advance = (index: number) => {
        pending.set(
          index,
          sources[index].next().then(
            (result) => ({ index, result }),
            (error: unknown) => ({ index, error }),
          ),
        );
      };
      let started = 0;
      advance(started++);
      while (pending.size) {
        const answer = await abortable(
          signal,
          () => Promise.race(pending.values()),
        );
        pending.delete(answer.index);
        try {
          if (answer.result === undefined) throw answer.error;
          if (!answer.result.done) {
            yielded = true;
            yield answer.result.value;
            // Resumption means the dialer could not connect. Retain this
            // target's pending family, but race it with later targets so no
            // stalled DNS answer can consume the whole failover deadline.
            advance(answer.index);
            while (started < sources.length) advance(started++);
          }
        } catch (error) {
          discoveryFallback(error, signal);
        }
        if (!yielded && pending.size === 0 && started < sources.length) {
          advance(started++);
        }
      }
      if (!yielded) {
        throw new UpstreamError('transport', {
          phase: 'dns',
          reason: 'no federation service target could be resolved',
        });
      }
    })();
  }
  return null;
}

// The production ladder: DNS + the cached .well-known fetch + the roster
// in the server file.
export async function resolve(
  server: Db,
  name: string,
  signal?: AbortSignal,
): Promise<Endpoint> {
  const deps: ResolveDeps = {
    dnsA: (h) => defaultDns(h, 'A', signal),
    dnsAAAA: (h) => defaultDns(h, 'AAAA', signal),
    dnsSrv: (h) => defaultSrv(h, signal),
    wellKnownGet: (h) => defaultWellKnownGet(h, signal),
    lookupPeer: (n) => lookupPeer(server, n),
  };
  return await resolveWith(name, deps, signal);
}
