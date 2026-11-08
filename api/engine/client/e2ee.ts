// C-S composition: tenant-local transactions and bounded signed origin requests.
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  bounded,
  type Json,
  limitEntries,
  object,
  validateUpload,
} from '#engine/tenant/e2ee.ts';
import {
  claimRequest,
  localClaim,
  localQuery,
  queryRequest,
} from '#engine/e2ee.ts';
import { federationRequest } from '#engine/federation/client.ts';
import { admit } from '#engine/federation/gate.ts';
import { abortable } from '#engine/net/abort.ts';
import { publicDeviceKey } from '#engine/e2ee-remote.ts';
import { cachedDeviceKeys } from '#engine/server/remote-devices.ts';

export async function uploadKeys(
  userId: string,
  deviceId: string | undefined,
  generation: number | undefined,
  body: unknown,
): Promise<Json> {
  if (deviceId === undefined || generation === undefined) {
    throw new MatrixError(
      400,
      'M_MISSING_PARAM',
      'an authenticated device is required',
    );
  }
  const tenant = theApp().tenant;
  const input = validateUpload(body, userId, deviceId, config().e2ee);
  const counts = await tenant.tx((tx) =>
    tx.e2ee.upload(
      { localpart: localpartOf(userId), deviceId, generation },
      input,
    )
  );
  return { one_time_key_counts: counts };
}

type Requests = [string, string[] | Record<string, string>][];
const unavailable = () => ({
  errcode: 'M_UNAVAILABLE',
  error: 'remote keys unavailable',
});

/** Validate the complete origin answer before publishing any part of it. */
function remoteKeys(
  value: unknown,
  requests: Requests,
  claim: boolean,
  requester: string,
): { keys: Json; count: number } {
  const limits = config().e2ee;
  bounded(value, limits.maxrequestbytes);
  const source = object(
    object(value, 'response')[claim ? 'one_time_keys' : 'device_keys'],
    'keys',
  );
  const wanted = new Map(requests);
  const keys: Json = Object.create(null);
  let count = 0;
  for (const [user, devices] of Object.entries(source)) {
    const ids = wanted.get(user);
    if (ids === undefined) throw new Error('origin returned unrequested user');
    const result: Json = Object.create(null);
    for (const [id, raw] of Object.entries(object(devices, 'devices'))) {
      if (
        Array.isArray(ids)
          ? ids.length > 0 && !ids.includes(id)
          : !Object.hasOwn(ids, id)
      ) throw new Error('origin returned unrequested device');
      limitEntries(++count, limits.maxkeys);
      bounded(raw, limits.maxkeybytes);
      if (claim) {
        const entries = Object.entries(object(raw, 'claimed key'));
        if (entries.length !== 1) throw new Error('invalid claimed key count');
        const [keyId, key] = entries[0];
        if (
          !keyId.startsWith((ids as Record<string, string>)[id] + ':') ||
          keyId.endsWith(':')
        ) throw new Error('invalid claimed algorithm');
        if (
          typeof key !== 'string' &&
          typeof object(key, 'claimed key').key !== 'string'
        ) throw new Error('invalid claimed material');
        result[id] = raw;
      } else {
        result[id] = publicDeviceKey(raw, user, id, limits, requester);
      }
    }
    keys[user] = result;
  }
  return { keys, count };
}

async function composed(
  requester: string,
  body: unknown,
  claim: boolean,
): Promise<Json> {
  const app = theApp(), limits = config().e2ee;
  const parsed = claim
    ? claimRequest(body, limits)
    : queryRequest(body, limits);
  const requestedTimeout = object(body, 'body').timeout;
  const timeout = requestedTimeout === undefined ? 10_000 : requestedTimeout;
  if (
    typeof timeout !== 'number' || !Number.isSafeInteger(timeout) || timeout < 0
  ) {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'timeout must be nonnegative integer milliseconds',
    );
  }
  const local = parsed.filter(([user]) =>
    domainOf(user) === app.tenant.serverName
  );
  const groups = new Map<string, Requests>();
  for (const entry of parsed) {
    const origin = domainOf(entry[0])!;
    if (origin === app.tenant.serverName) continue;
    if (!groups.has(origin)) groups.set(origin, []);
    groups.get(origin)!.push(entry);
  }
  // Reserve every possible failure before consuming local keys. Later merges
  // can only replace this reservation when the complete response still fits.
  const failures: Json = Object.create(null);
  for (const origin of groups.keys()) failures[origin] = unavailable();
  const field = claim ? 'one_time_keys' : 'device_keys';
  const response = claim
    ? await localClaim(
      app.tenant,
      local as Parameters<typeof localClaim>[1],
      limits,
      failures,
    )
    : await localQuery(
      app.tenant,
      local as Parameters<typeof localQuery>[1],
      requester,
      limits,
      failures,
    );
  let count = Object.values(response[field] as Json).reduce<number>(
    (n, keys) => n + Object.keys(keys as Json).length,
    0,
  );
  const iterator = groups.entries();
  const deadline = new AbortController();
  // Client timeout is a maximum; the configured transport ceiling still applies.
  const timer = setTimeout(
    () => deadline.abort(),
    Math.min(timeout, config().federation.timeoutms, 2_147_483_647),
  );
  if (timeout === 0) deadline.abort();
  try {
    // Four bounded answers in flight, never one unbounded Promise per user.
    await Promise.all(
      Array.from({ length: Math.min(4, groups.size) }, async () => {
        for (const [origin, requests] of iterator) {
          if (deadline.signal.aborted) break;
          try {
            await abortable(deadline.signal, () =>
              admit(app.server, origin, {
                kind: 'outbound',
                user: requester,
                what: claim ? 'claim device keys' : 'query device keys',
              }));
            const cached: Json = Object.create(null);
            const missing: Requests = [];
            for (const entry of requests) {
              await abortable(
                deadline.signal,
                () => app.deviceLists.recover(entry[0], deadline.signal),
              );
              const keys = claim
                ? null
                : await abortable(deadline.signal, () =>
                  cachedDeviceKeys(
                    app.server,
                    entry[0],
                    entry[1] as string[],
                    requester,
                  ));
              if (keys === null) missing.push(entry);
              else cached[entry[0]] = keys;
            }
            const res = missing.length
              ? await federationRequest(
                app.server,
                app.tenant.signer(),
                {
                  destination: origin,
                  method: 'POST',
                  path: '/_matrix/federation/v1/user/keys/' +
                    (claim ? 'claim' : 'query'),
                  body: new TextEncoder().encode(
                    JSON.stringify({ [field]: Object.fromEntries(missing) }),
                  ),
                  maxBytes: limits.maxrequestbytes,
                  signal: deadline.signal,
                },
              )
              : null;
            deadline.signal.throwIfAborted();
            const answer = res === null
              ? { keys: {}, count: 0 }
              : remoteKeys(res.json, missing, claim, requester);
            answer.keys = { ...cached, ...answer.keys };
            answer.count += Object.values(cached).reduce<number>(
              (n, keys) => n + Object.keys(keys as Json).length,
              0,
            );
            limitEntries(count + answer.count, limits.maxkeys);
            const merged = { ...(response[field] as Json), ...answer.keys };
            const remaining = { ...failures };
            delete remaining[origin];
            bounded(
              { ...response, [field]: merged, failures: remaining },
              limits.maxrequestbytes,
            );
            // No await between budget validation and publication.
            response[field] = merged;
            delete failures[origin];
            count += answer.count;
          } catch {
            /* Destination failed; keep its bounded reservation. Claims are never retried. */
          }
        }
      }),
    );
  } finally {
    clearTimeout(timer);
  }
  return response;
}
export async function queryKeys(
  requester: string,
  body: unknown,
): Promise<Json> {
  return await composed(requester, body, false);
}
export async function claimKeys(
  requester: string,
  body: unknown,
): Promise<Json> {
  return await composed(requester, body, true);
}
