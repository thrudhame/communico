// Every integer leaf has an explicit domain. Durations are bounded after unit
// conversion, before reaching timers or timestamp arithmetic.
import { type Config, type SCHEMA } from './config-schema.ts';

type IntPaths<T> = {
  [K in keyof T & string]: T[K] extends 'int' ? K
    : T[K] extends object ? `${K}.${IntPaths<T[K]>}`
    : never;
}[keyof T & string];
type Domain = { min: number; scale?: number; max?: number; timer?: boolean };
const positive = { min: 1 };
const nonnegative = { min: 0 };
const milliseconds = { min: 1, timer: true };
const seconds = { min: 1, scale: 1000 };
const hours = { min: 0, scale: 3600000 };
const days = { min: 0, scale: 86400000 };
export const INTEGER_DOMAINS = {
  'server.port': { min: 0, max: 65535 },
  'server.shutdowngraceseconds': { min: 0, scale: 1000, timer: true },
  'server.maxrequestbytes': positive,
  'turn.ttl': { min: 0, scale: 1000 },
  'hierarchy.pagesize': positive,
  'hierarchy.maxpagesize': positive,
  'hierarchy.maxdepth': nonnegative,
  'hierarchy.sessionseconds': seconds,
  'hierarchy.maxsessions': positive,
  'hierarchy.maxsessionsperuser': positive,
  'hierarchy.maxrooms': positive,
  'peeking.maxevents': positive,
  'peeking.maxtimeoutms': { min: 0, timer: true },
  'openid.tokenseconds': seconds,
  'uia.sessionseconds': seconds,
  'uia.maxsessions': positive,
  'delayedevents.maxdelayms': {
    min: 0,
    max: Number.MAX_SAFE_INTEGER - Date.now(),
  },
  'delayedevents.maxperuser': nonnegative,
  'slidingsync.connectionseconds': seconds,
  'slidingsync.maxconnections': positive,
  'slidingsync.maxconnectionsperdevice': positive,
  'slidingsync.maxsnapshotbytes': positive,
  'slidingsync.maxtimeoutms': { min: 0, timer: true },
  'media.maxbytes': positive,
  'media.timeoutms': milliseconds,
  'media.maxfetches': positive,
  'media.maxredirects': nonnegative,
  'media.maxpixels': positive,
  'media.maxdimension': positive,
  'media.thumbnailms': milliseconds,
  'media.thumbnailworkers': positive,
  'media.maxvariants': positive,
  'media.cleanupseconds': { ...seconds, timer: true },
  'media.cache.maxbytes': nonnegative,
  'media.cache.remote.maxagedays': days,
  'media.cache.remote.unopenedday': days,
  'media.cache.remote.maxbytes': nonnegative,
  'media.cache.thumbnail.maxagedays': days,
  'media.cache.thumbnail.unopenedday': days,
  'media.cache.thumbnail.maxbytes': nonnegative,
  'e2ee.maxrequestbytes': nonnegative,
  'e2ee.maxkeybytes': nonnegative,
  'e2ee.maxkeys': nonnegative,
  'e2ee.maxonetimekeys': nonnegative,
  'e2ee.maxinboxmessages': nonnegative,
  'e2ee.maxdestinationmessages': nonnegative,
  'e2ee.maxbackupsessions': nonnegative,
  'e2ee.maxbackupversions': nonnegative,
  'e2ee.maxbackupbytes': nonnegative,
  'push.readretentiondays': days,
  'push.deliverygiveuphours': hours,
  'store.checkpointlogbytes': positive,
  'store.maxopenfiles': positive,
  'store.idleseconds': { ...seconds, timer: true },
  'preview.maxbytes': positive,
  'federation.port': { min: 0, max: 65535 },
  'federation.keyvalidityhours': { min: 1, max: 168 },
  'federation.wellknownmaxage': nonnegative,
  'federation.connectms': milliseconds,
  'federation.timeoutms': milliseconds,
  'federation.maxbytes': positive,
  'federation.wellknownhours': hours,
  'federation.wellknownmaxhours': hours,
  'federation.wellknownerrorhours': hours,
  'federation.keyfailminutes': { min: 0, scale: 60000 },
  'federation.witnesses': positive,
  'federation.pendingmax': nonnegative,
  'federation.pendingdays': days,
  'federation.discoveryservers': positive,
  'federation.missingwaitms': milliseconds,
  'federation.missinglimit': positive,
  'federation.missingbudgetms': milliseconds,
  'federation.missingmax': positive,
  'federation.backfillbatch': positive,
  'federation.backfillmax': positive,
  'federation.bulkmaxbytes': positive,
  'federation.backoffstartmillihours': { min: 1, scale: 3600 },
  'federation.backoffmaxmillihours': { min: 1, scale: 3600 },
  'federation.refusedmillihours': { min: 1, scale: 3600 },
  'federation.ungroundedmillihours': { min: 0, scale: 3600 },
  'federation.txnhours': { min: 1, scale: 3600000 },
} satisfies Record<IntPaths<typeof SCHEMA>, Domain>;

export function validateNumbers(
  built: Partial<Config>,
  now = Date.now(),
): string[] {
  const problems: string[] = [];
  for (const [node, domain] of Object.entries(INTEGER_DOMAINS)) {
    const value = node.split('.').reduce<unknown>(
      (obj, key) =>
        obj && typeof obj === 'object'
          ? (obj as Record<string, unknown>)[key]
          : undefined,
      built,
    );
    if (typeof value !== 'number') continue; // Missing/type errors belong to coercion.
    const { min, scale = 1, timer = false, max = Number.MAX_SAFE_INTEGER } =
      domain as Domain;
    const ceiling = Math.min(
      max,
      Math.floor(
        (timer
          ? 2147483647
          : scale > 1
          ? Number.MAX_SAFE_INTEGER - now
          : Number.MAX_SAFE_INTEGER) / scale,
      ),
    );
    if (!Number.isSafeInteger(value) || value < min || value > ceiling) {
      const minimum = min === 1 ? '> 0 (>= 1)' : `>= ${min}`;
      problems.push(
        `config: ${node} (COMMUNICO_${
          node.replaceAll('.', '_').toUpperCase()
        }): expected ${minimum} and <= ${ceiling}, a safe integer, got ${value}`,
      );
    }
  }
  return problems;
}
