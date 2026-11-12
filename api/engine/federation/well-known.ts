// Optional discovery, starting at HTTPS and following HTTP(S) redirects. Only
// classified peer outcomes fall back; a local
// CA/configuration fault or caller cancellation is not a cacheable peer miss.
import { config } from '#engine/config.ts';
import { decodeJson, objectOf, stringOf } from '#engine/net/json.ts';
import { fieldList, parameterized, TOKEN } from '#engine/net/fields.ts';
import { http1Request, type Http1Response } from '#engine/net/http1.ts';
import {
  limit,
  protocol,
  recoverableUpstream,
  UpstreamError,
  UpstreamHttpError,
} from '#engine/net/upstream-error.ts';
import { dialNodeTls } from './dial-node-tls.ts';
import { isIpLiteral, splitServerName } from './server-name.ts';

type Answer = { mServer: string | null; maxAgeMs: number | null };
const cache = new Map<
  string,
  { answer: Answer; expiresMs: number; failure?: unknown }
>();
export function resetWellKnownCache(): void {
  cache.clear();
}

// Cache-Control is a case-insensitive list, with quoted directive values. A
// malformed/duplicate freshness value is stale, not an invented long lifetime.
function cacheLifetime(
  headers: Headers | null,
  fallback: number,
  maximum: number,
  elapsed: number,
): number {
  if (headers === null) return Math.min(fallback, maximum);
  const cc = headers.get('cache-control');
  const directives = new Map<string, string[]>();
  if (cc !== null) {
    let pieces: string[];
    try {
      pieces = fieldList(cc, 'cache-control');
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.category !== 'protocol') {
        throw error;
      }
      return 0;
    }
    for (const piece of pieces) {
      const directive = piece.replace(/^[ \t]+|[ \t]+$/g, '');
      if (!directive) continue;
      let name: string, value: string;
      if (TOKEN.test(directive)) {
        name = directive.toLowerCase();
        value = '';
      } else {
        try {
          const params =
            parameterized('cache;' + directive, 'cache-control').parameters;
          if (params.size !== 1) return 0;
          const [key, values] = [...params][0];
          if (values.length !== 1) return 0;
          name = key;
          value = values[0];
        } catch (error) {
          // A malformed remote field cannot make discovery fail or cache longer.
          if (!recoverableUpstream(error)) throw error;
          return 0;
        }
      }
      const values = directives.get(name);
      directives.set(name, [...(values === undefined ? [] : values), value]);
    }
  }
  if (directives.has('no-store') || directives.has('no-cache')) return 0;
  const ages = directives.get('max-age');
  let lifetime = Math.min(fallback, maximum);
  if (ages !== undefined) {
    if (ages.length !== 1 || !/^\d+$/.test(ages[0])) return 0;
    lifetime = Math.min(maximum, Number(ages[0]) * 1000);
  }
  const age = headers.get('age');
  if (age !== null && !/^\d+$/.test(age)) return 0;
  const date = headers.get('date');
  const apparentAge = date === null
    ? 0
    : Math.max(0, Date.now() - Date.parse(date));
  return Math.max(
    0,
    lifetime -
      Math.max(
        (age === null ? 0 : Number(age) * 1000) + elapsed,
        Number.isNaN(apparentAge) ? 0 : apparentAge,
      ),
  );
}

export async function wellKnownGet(
  host: string,
  addresses: (host: string) => Promise<string[]>,
  caCerts: () => string[],
  signal?: AbortSignal,
): Promise<Answer> {
  signal?.throwIfAborted();
  const hit = cache.get(host);
  if (hit !== undefined && hit.expiresMs > Date.now()) return hit.answer;
  let headers: Headers | null = null, started = Date.now();
  let answer: Answer, failure: unknown;
  const fed = config().federation;
  const maximum = fed.wellknownmaxhours * 3600_000;
  let chainLifetime = Infinity;
  try {
    let url = new URL('https://' + host + '/.well-known/matrix/server');
    for (let hops = 0;; hops++) {
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        protocol('well-known', 'unsupported discovery redirect scheme');
      }
      // Never turn URL user-info into Authorization on a redirected request.
      headers = null;
      const name = splitServerName(url.host);
      const ips = await addresses(name.host);
      started = Date.now();
      const request = {
        port: name.port === null
          ? (url.protocol === 'https:' ? 443 : 80)
          : name.port,
        hostHeader: url.host,
        method: 'GET',
        path: url.pathname + url.search,
        headers: { Accept: 'application/json' },
        body: null,
        connectMs: fed.connectms,
        timeoutMs: fed.timeoutms,
        maxBytes: fed.maxbytes,
        signal,
      };
      let res: Http1Response | undefined;
      if (url.protocol === 'https:') {
        res = await dialNodeTls({
          ...request,
          connectIp: ips[0],
          alternatives: ips.slice(1).map((connectIp) => ({
            connectIp,
            port: request.port,
          })),
          sni: isIpLiteral(name.host) ? null : name.host,
          trust: { kind: 'ca', caCerts: caCerts() },
        });
      } else {
        for (let i = 0; i < ips.length; i++) {
          try {
            res = await http1Request({
              ...request,
              connectIp: ips[i],
              tls: null,
            });
            break;
          } catch (error) {
            signal?.throwIfAborted();
            if (
              !(error instanceof UpstreamError) ||
              error.category !== 'transport' ||
              error.context.phase !== 'connect' || i === ips.length - 1
            ) throw error;
          }
        }
      }
      if (res === undefined) protocol('well-known', 'no discovery address');
      headers = res.headers;
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        if (hops >= 5) limit('well-known', 'too many discovery redirects');
        const location = headers.get('location');
        if (location === null) {
          protocol('well-known', 'redirect without Location');
        }
        chainLifetime = Math.min(
          chainLifetime,
          cacheLifetime(
            headers,
            fed.wellknownhours * 3600_000,
            maximum,
            Date.now() - started,
          ),
        );
        try {
          url = new URL(location, url);
        } catch (cause) {
          protocol('well-known', 'invalid discovery redirect', cause);
        }
        continue;
      }
      if (res.status !== 200) {
        throw new UpstreamHttpError(res.status, 'well-known');
      }
      const body = objectOf(
        decodeJson(res.body, headers.get('content-type')),
        'well-known',
      );
      const mServer = stringOf(body['m.server'], 'well-known');
      splitServerName(mServer);
      answer = { mServer, maxAgeMs: null };
      break;
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (!recoverableUpstream(error, signal)) throw error;
    failure = error;
    answer = { mServer: null, maxAgeMs: null };
  }
  const fallback =
    (failure === undefined ? fed.wellknownhours : fed.wellknownerrorhours) *
    3600_000;
  const effective = Math.min(
    chainLifetime,
    cacheLifetime(headers, fallback, maximum, Date.now() - started),
  );
  answer.maxAgeMs = effective;
  if (effective > 0) {
    cache.set(host, { answer, expiresMs: Date.now() + effective, failure });
  } else cache.delete(host);
  return answer;
}
