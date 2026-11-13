// C-S composition: tenant-local transactions and bounded signed origin requests.
import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { domainOf, localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { type Json, object, validateUpload } from '#engine/tenant/e2ee.ts';
import * as wire from '#engine/e2ee-wire.ts';
import { optionalField } from '#engine/net/json.ts';
import {
  protocol,
  recoverableUpstream,
  UpstreamError,
} from '#engine/net/upstream-error.ts';
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
import {
  cachedKeyQuery,
  withRemoteSigningState,
} from '#engine/server/remote-devices.ts';
import {
  publicSigning,
  signingViews,
  verifiedPublicSigning,
} from '#engine/e2ee-public-signing.ts';

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
async function remoteKeys(
  value: unknown,
  requests: Requests,
  claim: boolean,
  requester: string,
): Promise<{ keys: Json; signing: Json; count: number }> {
  const limits = config().e2ee;
  wire.bounded(value, limits.maxrequestbytes);
  const source = wire.object(
    wire.object(value, 'response')[claim ? 'one_time_keys' : 'device_keys'],
    'keys',
  );
  const wanted = new Map(requests);
  const keys: Json = Object.create(null);
  const signing: Json = {};
  let count = 0;
  for (const [user, devices] of Object.entries(source)) {
    const ids = wanted.get(user);
    if (ids === undefined) wire.identity('origin returned unrequested user');
    const result: Json = Object.create(null);
    for (const [id, raw] of Object.entries(wire.object(devices, 'devices'))) {
      if (
        Array.isArray(ids)
          ? ids.length > 0 && !ids.includes(id)
          : !Object.hasOwn(ids, id)
      ) wire.identity('origin returned unrequested device');
      wire.limitEntries(++count, limits.maxkeys);
      wire.bounded(raw, limits.maxkeybytes);
      if (claim) {
        const entries = Object.entries(wire.object(raw, 'claimed key'));
        if (entries.length !== 1) {
          protocol('e2ee-schema', 'invalid claimed key count');
        }
        const [keyId, key] = entries[0];
        if (
          !keyId.startsWith((ids as Record<string, string>)[id] + ':') ||
          keyId.endsWith(':')
        ) wire.identity('invalid claimed algorithm');
        const [algorithm] = wire.keyId(keyId);
        wire.claimedKey(key, algorithm, limits);
        result[id] = raw;
      } else {
        result[id] = publicDeviceKey(raw, user, id, limits, requester);
      }
    }
    keys[user] = result;
  }
  if (!claim) {
    const answer = wire.object(value, 'response');
    const signingMaps: Record<string, Json> = {};
    for (const field of ['master_keys', 'self_signing_keys']) {
      const map = optionalField(
        answer[field],
        (raw) => wire.object(raw, field),
      );
      if (map === undefined) continue;
      signingMaps[field] = map;
      for (const [user, key] of Object.entries(map)) {
        if (!wanted.has(user)) {
          wire.identity('origin returned unrequested signing user');
        }
        // Map values are required objects, not optional schema properties.
        wire.object(key, field + ' entry');
      }
    }
    for (const [user] of requests) {
      const supplied = publicSigning(
        {
          master_key: signingMaps.master_keys?.[user],
          self_signing_key: signingMaps.self_signing_keys?.[user],
        },
        user,
        limits,
      );
      const publicKeys = await verifiedPublicSigning(supplied, user, limits);
      count += Object.keys(publicKeys).length;
      wire.limitEntries(count, limits.maxkeys);
      mergeViews(signing, signingViews(publicKeys, user, requester));
    }
  }
  return { keys, signing, count };
}

function mergeViews(target: Json, source: Json): void {
  for (const [field, users] of Object.entries(source)) {
    target[field] = { ...(target[field] as Json), ...(users as Json) };
  }
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
  if (!claim) {
    count += ['master_keys', 'self_signing_keys', 'user_signing_keys'].reduce(
      (n, f) => n + Object.keys(response[f] as Json).length,
      0,
    );
  }
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
    const outcomes = await Promise.allSettled(
      Array.from({ length: Math.min(4, groups.size) }, async () => {
        for (const [origin, requests] of iterator) {
          if (deadline.signal.aborted) break;
          try {
            try {
              await abortable(deadline.signal, () =>
                admit(app.server, origin, {
                  kind: 'outbound',
                  user: requester,
                  what: claim ? 'claim device keys' : 'query device keys',
                }));
            } catch (error) {
              if (
                !(error instanceof MatrixError && error.status === 403 &&
                  error.errcode === 'M_FORBIDDEN')
              ) throw error;
              throw new UpstreamError('validation', {
                phase: 'e2ee-admission',
                reason: 'remote key request refused by policy',
                cause: error,
              });
            }
            const cached: Json = Object.create(null), cachedSigning: Json = {};
            const missing: Requests = [];
            const revisions = new Map<string, number>();
            for (const entry of requests) {
              await abortable(
                deadline.signal,
                () => app.deviceLists.recover(entry[0], deadline.signal),
              );
              revisions.set(
                entry[0],
                await abortable(deadline.signal, () =>
                  withRemoteSigningState(
                    app.server,
                    entry[0],
                    (state) => Promise.resolve(state.revision),
                  )),
              );
              const keys = claim
                ? null
                : await abortable(deadline.signal, () =>
                  cachedKeyQuery(
                    app.server,
                    entry[0],
                    entry[1] as string[],
                    requester,
                  ));
              if (keys === null) missing.push(entry);
              else {
                cached[entry[0]] = (keys.device_keys as Json)[entry[0]];
                const { device_keys: _devices, ...views } = keys;
                mergeViews(cachedSigning, views);
              }
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
              ? { keys: {}, signing: {}, count: 0 }
              : await remoteKeys(res.json, missing, claim, requester);
            answer.keys = { ...cached, ...answer.keys };
            answer.count += Object.values(cached).reduce<number>(
              (n, keys) => n + Object.keys(keys as Json).length,
              0,
            );
            mergeViews(answer.signing, cachedSigning);
            if (!claim) {
              const masters = answer.signing.master_keys as Json | undefined;
              for (const [user, raw] of Object.entries(masters ?? {})) {
                masters![user] = await abortable(
                  deadline.signal,
                  () =>
                    withRemoteSigningState(
                      app.server,
                      user,
                      async (state) => {
                        if (
                          state.revision !== revisions.get(user)
                        ) wire.identity('remote signing keys changed');
                        const key = raw as Json;
                        const id = Object.keys(key.keys as Json)[0].slice(8);
                        return await app.tenant.tx((tx) =>
                          tx.keySignatures.remoteView(
                            key,
                            user,
                            id,
                            requester,
                            state.revision,
                          )
                        );
                      },
                    ),
                );
              }
            }
            answer.count += Object.values(cachedSigning).reduce(
              (n: number, users) => n + Object.keys(users as Json).length,
              0,
            );
            deadline.signal.throwIfAborted();
            wire.limitEntries(count + answer.count, limits.maxkeys);
            const merged = { ...(response[field] as Json), ...answer.keys };
            const remaining = { ...failures };
            delete remaining[origin];
            const next: Json = {
              ...response,
              [field]: merged,
              failures: remaining,
            };
            mergeViews(next, answer.signing);
            wire.bounded(
              next,
              limits.maxrequestbytes,
            );
            // No await between budget validation and publication.
            response[field] = merged;
            for (const f of Object.keys(answer.signing)) response[f] = next[f];
            delete failures[origin];
            count += answer.count;
          } catch (error) {
            if (!recoverableUpstream(error, deadline.signal)) {
              deadline.abort(error);
              throw error;
            }
            /* Destination failed; keep its bounded reservation. Claims are never retried. */
          }
        }
      }),
    );
    // Drain all in-flight consumers before exposing a local failure to callers.
    // Claims are not replayed and no worker outlives its deadline owner.
    const failed = outcomes.find((outcome) => outcome.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
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
