// One phased public/service capability manifest. This is a pre-dispatch gate, not a
// second Matrix router: allowed requests still use reflective route discovery.
export type Role = 'home' | 'facade';
export type Scope =
  | 'discovery'
  | 'keys'
  | 'public'
  | 'rooms'
  | 'ingress'
  | 'auth'
  | 'domain'
  | 'clientrooms';
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

// B2 delivers account/session authority. Later capabilities remain unmounted
// until their owning slices, even when their endpoints exist on home.
const F2_AUTH: readonly Rule[] = [
  ...['v3', 'r0'].flatMap((version) =>
    ['GET', 'POST'].map((method) =>
      route(method, literal('/_matrix/client/' + version + '/login'), 'auth')
    )
  ),
  ...['refresh', 'logout', 'logout/all', 'delete_devices', 'account/deactivate']
    .map((name) =>
      route('POST', literal('/_matrix/client/v3/' + name), 'auth')
    ),
  route('GET', literal('/_matrix/client/v3/account/whoami'), 'auth'),
  ...['PUT', 'DELETE'].map((method) =>
    route(method, /^\/_matrix\/client\/v3\/devices\/[^/]+$/, 'auth')
  ),
  ...['register', 'account/password', 'keys/device_signing/upload'].map((
    name,
  ) => route('POST', literal('/_matrix/client/v3/' + name), 'auth', 'home')),
  route(
    'GET',
    literal('/_matrix/client/v3/register/available'),
    'auth',
    'home',
  ),
];

// B3's type owners enforce complete per-user domain cuts. Receipt entry points
// additionally require their room cut. These client scopes do not depend on the
// federation switch; the existing federation public/rooms rules still do.
const F2_REGISTERS: readonly Rule[] = [
  route('GET', /^\/_matrix\/client\/v3\/profile\/[^/]+(?:\/[^/]+)?$/, 'domain'),
  ...['PUT', 'DELETE'].map((method) =>
    route(method, /^\/_matrix\/client\/v3\/profile\/[^/]+\/[^/]+$/, 'domain')
  ),
  route('GET', /^\/_matrix\/client\/v3\/pushrules\/?$/, 'domain'),
  route('GET', /^\/_matrix\/client\/v3\/pushrules\/global\/?$/, 'domain'),
  ...['GET', 'PUT', 'DELETE'].map((method) =>
    route(
      method,
      /^\/_matrix\/client\/v3\/pushrules\/global\/[^/]+\/[^/]+$/,
      'domain',
    )
  ),
  ...['GET', 'PUT'].map((method) =>
    route(
      method,
      /^\/_matrix\/client\/v3\/pushrules\/global\/[^/]+\/[^/]+\/(actions|enabled)$/,
      'domain',
    )
  ),
  ...['GET', 'PUT'].map((method) =>
    route(
      method,
      /^\/_matrix\/client\/v3\/user\/[^/]+\/(?:rooms\/[^/]+\/)?account_data\/[^/]+$/,
      'domain',
    )
  ),
  route(
    'GET',
    /^\/_matrix\/client\/v3\/user\/[^/]+\/rooms\/[^/]+\/tags$/,
    'domain',
  ),
  ...['PUT', 'DELETE'].map((method) =>
    route(
      method,
      /^\/_matrix\/client\/v3\/user\/[^/]+\/rooms\/[^/]+\/tags\/[^/]+$/,
      'domain',
    )
  ),
  route(
    'POST',
    /^\/_matrix\/client\/v3\/rooms\/[^/]+\/read_markers$/,
    'domain',
  ),
  route(
    'POST',
    /^\/_matrix\/client\/v3\/rooms\/[^/]+\/receipt\/[^/]+\/[^/]+$/,
    'domain',
  ),
];

// B4 composes the existing device and remote-key owners. Client requests use
// the authenticated ingress scope, independently of federation being enabled.
const F2_DEVICES: readonly Rule[] = [
  route('GET', /^\/_matrix\/client\/v3\/devices(?:\/[^/]+)?$/, 'auth'),
  ...['upload', 'query', 'claim', 'signatures/upload'].map((name) =>
    route('POST', literal('/_matrix/client/v3/keys/' + name), 'auth')
  ),
  route('POST', literal(f + 'user/keys/claim'), 'public'),
];

// B5 sends retain local targets and remote/other-owner obligations before 200.
// Inbox publication remains gated independently by the sync capability slice.
const F2_TODEVICE: readonly Rule[] = [
  route('PUT', /^\/_matrix\/client\/v3\/sendToDevice\/[^/]+\/[^/]+$/, 'auth'),
];

// B9 shares the native sync coordinators and their owner-local issued receipts.
const F2_SYNC: readonly Rule[] = [
  ...['sync', 'keys/changes'].map((name) =>
    route('GET', literal('/_matrix/client/v3/' + name), 'domain')
  ),
  route(
    'POST',
    literal('/_matrix/client/unstable/org.matrix.simplified_msc3575/sync'),
    'domain',
  ),
];

// B6's client room owners enforce their exact room/account cuts. This is not
// the federation rooms scope: local clients still work with federation off.
const F2_ROOMS: readonly Rule[] = [
  route('POST', literal('/_matrix/client/v3/createRoom'), 'clientrooms'),
  ...['send', 'redact'].map((name) =>
    route(
      'PUT',
      new RegExp('^/_matrix/client/v3/rooms/[^/]+/' + name + '/[^/]+/[^/]+$'),
      'clientrooms',
    )
  ),
  route('GET', /^\/_matrix\/client\/v3\/rooms\/[^/]+\/state$/, 'clientrooms'),
  ...['GET', 'PUT'].map((method) =>
    route(
      method,
      /^\/_matrix\/client\/v3\/rooms\/[^/]+\/state\/[^/]+(?:\/[^/]*)?$/,
      'clientrooms',
    )
  ),
  route(
    'GET',
    /^\/_matrix\/client\/v3\/rooms\/[^/]+\/(?:event|context)\/[^/]+$/,
    'clientrooms',
  ),
  route(
    'GET',
    /^\/_matrix\/client\/v3\/rooms\/[^/]+\/(?:messages|members|joined_members|initialSync)$/,
    'clientrooms',
  ),
];

// B7 reuses the membership owners and their durable admission/receipt gates.
// Forget and the remaining private read surfaces belong to B8; sync to B9.
const F2_MEMBERSHIP: readonly Rule[] = [
  ...['make_join', 'make_knock', 'make_leave'].map((name) =>
    route('GET', new RegExp('^' + f + name + '/[^/]+/[^/]+$'), 'rooms')
  ),
  ...['send_join', 'send_knock', 'send_leave'].map((name) =>
    route('PUT', new RegExp('^' + f + name + '/[^/]+/[^/]+$'), 'rooms')
  ),
  ...['send_join', 'send_leave', 'invite'].map((name) =>
    route(
      'PUT',
      new RegExp('^/_matrix/federation/v2/' + name + '/[^/]+/[^/]+$'),
      'rooms',
    )
  ),
  ...['join', 'knock'].map((name) =>
    route(
      'POST',
      new RegExp('^/_matrix/client/v3/' + name + '/[^/]+$'),
      'clientrooms',
    )
  ),
  route(
    'POST',
    /^\/_matrix\/client\/v3\/rooms\/[^/]+\/(?:join|invite|leave|kick|ban|unban)$/,
    'clientrooms',
  ),
];

// B8 adds each private surface only after its owning semantic contract exists.
const F2_CLIENT_DATA: readonly Rule[] = [
  route(
    'GET',
    /^\/_matrix\/client\/unstable\/org\.matrix\.msc4140\/delayed_events(?:\/[^/]+)?$/,
    'domain',
  ),
  route(
    'POST',
    /^\/_matrix\/client\/unstable\/org\.matrix\.msc4140\/delayed_events\/[^/]+(?:\/[^/]+)?$/,
    'domain',
  ),
  route('GET', literal('/_matrix/client/v3/notifications'), 'domain'),
  route('POST', literal('/_matrix/client/v3/search'), 'domain'),
  route('GET', literal('/_matrix/client/v3/pushers'), 'domain'),
  route('POST', literal('/_matrix/client/v3/pushers/set'), 'domain'),
  route('POST', /^\/_matrix\/client\/v3\/rooms\/[^/]+\/forget$/, 'clientrooms'),
  route(
    'POST',
    /^\/_matrix\/client\/v3\/rooms\/[^/]+\/report(?:\/[^/]+)?$/,
    'domain',
  ),
  route('POST', /^\/_matrix\/client\/v3\/users\/[^/]+\/report$/, 'domain'),
  route(
    'GET',
    /^\/_matrix\/client\/v3\/room_keys\/(?:version(?:\/[^/]+)?|keys(?:\/[^/]+(?:\/[^/]+)?)?)$/,
    'domain',
  ),
  route(
    'POST',
    /^\/_matrix\/client\/v3\/room_keys\/version$/,
    'domain',
    'home',
  ),
  ...['PUT', 'DELETE'].map((method) =>
    route(
      method,
      /^\/_matrix\/client\/v3\/room_keys\/(?:version\/[^/]+|keys(?:\/[^/]+(?:\/[^/]+)?)?)$/,
      'domain',
      'home',
    )
  ),
  route(
    'POST',
    /^\/_matrix\/client\/v3\/user\/[^/]+\/openid\/request_token$/,
    'domain',
  ),
  route('GET', /^\/_matrix\/federation\/v1\/openid\/userinfo$/, 'domain'),
  route('POST', /^\/_matrix\/client\/v3\/user\/[^/]+\/filter$/, 'domain'),
  route('GET', /^\/_matrix\/client\/v3\/user\/[^/]+\/filter\/[^/]+$/, 'domain'),
];

const HOME_SERVICES = new Set([
  'recovery',
  'link-client',
  'push',
  'delayed',
  'media',
  'device-lists',
  'federation-sender',
  'deactivation',
]);
const FACADE_SERVICES = new Set([
  'recovery',
  'link-server',
  'link-inbox',
  'ingress',
  'egress',
]);

export function capabilities(role: string, phase = 'f1') {
  if (role !== 'home' && role !== 'facade') {
    throw new TypeError('unknown runtime role');
  }
  const services = role === 'home' ? HOME_SERVICES : FACADE_SERVICES;
  return {
    role,
    service(name: string): boolean {
      if (
        role === 'facade' && phase === 'f2' &&
        ['deactivation', 'device-lists', 'federation-sender', 'push', 'delayed']
          .includes(
            name,
          )
      ) {
        return true;
      }
      return services.has(name);
    },
    gate(request: Request, ready: (scope: Scope) => boolean): Response | null {
      if (role === 'home') return null;
      const path = new URL(request.url).pathname;
      const matching = (phase === 'f2'
        ? [
          ...F1_PUBLIC,
          ...F2_AUTH,
          ...F2_REGISTERS,
          ...F2_DEVICES,
          ...F2_TODEVICE,
          ...F2_SYNC,
          ...F2_ROOMS,
          ...F2_MEMBERSHIP,
          ...F2_CLIENT_DATA,
        ]
        : F1_PUBLIC)
        .filter((rule) => rule.path.test(path));
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
