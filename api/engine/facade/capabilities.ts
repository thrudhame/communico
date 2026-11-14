// One F1 public/service capability manifest. This is a pre-dispatch gate, not a
// second Matrix router: allowed requests still use reflective route discovery.
export type Role = 'home' | 'facade';
export type Scope = 'discovery' | 'keys' | 'public' | 'rooms' | 'ingress';
type Rule = { method: string; path: RegExp; scope: Scope; action?: 'home' };
const f = '/_matrix/federation/v1/';
const k = '/_matrix/key/v2/';
const literal = (path: string) =>
  new RegExp('^' + path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
const route = (
  method: string,
  path: RegExp,
  scope: Scope,
  action?: 'home',
): Rule => ({ method, path, scope, action });

export const F1_PUBLIC: readonly Rule[] = [
  ...['client', 'server', 'support'].map((name) =>
    route('GET', literal('/.well-known/matrix/' + name), 'discovery')
  ),
  route('GET', literal('/_matrix/client/versions'), 'discovery'),
  route('GET', literal(f + 'version'), 'discovery'),
  ...[
    'backfill',
    'event',
    'state',
    'state_ids',
    'timestamp_to_event',
    'hierarchy',
  ].map((name) =>
    route('GET', new RegExp('^' + f + name + '/[^/]+$'), 'rooms')
  ),
  route('GET', new RegExp('^' + f + 'event_auth/[^/]+/[^/]+$'), 'rooms'),
  route('POST', new RegExp('^' + f + 'get_missing_events/[^/]+$'), 'rooms'),
  route('GET', literal(f + 'publicRooms'), 'public'),
  route('POST', literal(f + 'publicRooms'), 'public'),
  route('GET', new RegExp('^' + f + 'query/(directory|profile)$'), 'public'),
  route('GET', new RegExp('^' + f + 'user/devices/[^/]+$'), 'public'),
  route('POST', literal(f + 'user/keys/query'), 'public'),
  route('GET', literal(k + 'server'), 'keys'),
  route('GET', new RegExp('^' + k + 'query/[^/]+$'), 'keys'),
  route('POST', literal(k + 'query'), 'keys'),
  route('PUT', new RegExp('^' + f + 'send/[^/]+$'), 'ingress'),
  route(
    'DELETE',
    /^\/_matrix\/client\/v3\/directory\/room\/[^/]+$/,
    'public',
    'home',
  ),
];

const HOME_SERVICES = new Set([
  'recovery',
  'link-client',
  'push',
  'delayed',
  'media',
  'device-lists',
  'federation-sender',
]);
const FACADE_SERVICES = new Set([
  'recovery',
  'link-server',
  'link-inbox',
  'ingress',
  'egress',
]);

export function capabilities(role: string) {
  if (role !== 'home' && role !== 'facade') {
    throw new TypeError('unknown runtime role');
  }
  const services = role === 'home' ? HOME_SERVICES : FACADE_SERVICES;
  return {
    role,
    service(name: string): boolean {
      return services.has(name);
    },
    gate(request: Request, ready: (scope: Scope) => boolean): Response | null {
      if (role === 'home') return null;
      const path = new URL(request.url).pathname;
      const matching = F1_PUBLIC.filter((rule) => rule.path.test(path));
      const rule = matching.find((rule) => rule.method === request.method);
      if (!rule) {
        return Response.json({
          errcode: 'M_UNRECOGNIZED',
          error: 'Unrecognized request',
        }, { status: matching.length ? 405 : 404 });
      }
      if (rule.action === 'home') {
        return Response.json({
          errcode: 'M_UNAVAILABLE',
          error: 'operation requires home ingress',
        }, { status: 503 });
      }
      if (!ready(rule.scope)) {
        return Response.json({
          errcode: 'M_UNAVAILABLE',
          error: 'replica scope unavailable',
        }, { status: 503 });
      }
      return null;
    },
  };
}
