// Shared key request/tenant service. Federation serves only this tenant; C-S
// partitions before calling it. No network is performed under a tenant gate.
import { domainOf, localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  bounded,
  type Json,
  type KeyLimits,
  limitEntries,
  object,
} from '#engine/tenant/e2ee.ts';

export type Query = [string, string[]][];
export type Claim = [string, Record<string, string>][];
export function keyRequests(
  body: unknown,
  field: string,
  limits: KeyLimits,
): [string, unknown][] {
  bounded(body, limits.maxrequestbytes);
  const entries = Object.entries(object(object(body, 'body')[field], field));
  limitEntries(entries.length, limits.maxkeys);
  for (const [user] of entries) {
    if (!/^@[^:]+:.+$/.test(user)) {
      throw new MatrixError(400, 'M_BAD_JSON', 'invalid user ID');
    }
  }
  return entries;
}
export function queryRequest(body: unknown, limits: KeyLimits): Query {
  const parsed: Query = keyRequests(body, 'device_keys', limits).map(
    ([user, ids]) => {
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new MatrixError(
          400,
          'M_BAD_JSON',
          'device IDs must be an array of strings',
        );
      }
      return [user, [...new Set(ids as string[])]];
    },
  );
  limitEntries(
    parsed.reduce((n, [, ids]) => n + Math.max(1, ids.length), 0),
    limits.maxkeys,
  );
  return parsed;
}
export function claimRequest(body: unknown, limits: KeyLimits): Claim {
  let count = 0;
  const parsed: Claim = keyRequests(body, 'one_time_keys', limits).map(
    ([user, devices]) => {
      const result: Record<string, string> = Object.create(null);
      for (
        const [id, algorithm] of Object.entries(
          object(devices, 'device algorithms'),
        )
      ) {
        if (!id.length || typeof algorithm !== 'string' || !algorithm.length) {
          throw new MatrixError(400, 'M_BAD_JSON', 'invalid device algorithm');
        }
        result[id] = algorithm;
        count++;
      }
      return [user, result];
    },
  );
  limitEntries(count, limits.maxkeys);
  return parsed;
}
export function ownUsers(tenant: Tenant, entries: [string, unknown][]): void {
  for (const [user] of entries) {
    if (domainOf(user) !== tenant.serverName) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'requested user is not local',
      );
    }
  }
}
export async function localQuery(
  tenant: Tenant,
  entries: Query,
  requester: string,
  limits: KeyLimits,
  failures?: Json,
): Promise<Json> {
  ownUsers(tenant, entries);
  return await tenant.tx(async (tx) => {
    const device_keys: Json = Object.create(null);
    const signing: Record<string, Json> = {
      master_keys: {},
      self_signing_keys: {},
      user_signing_keys: {},
    };
    let count = 0;
    for (const [user, ids] of entries) {
      const keys = await tx.e2ee.query(
        localpartOf(user),
        ids,
        requester,
        user,
        limits.maxkeys,
      );
      count += Object.keys(keys).length;
      limitEntries(count, limits.maxkeys);
      device_keys[user] = keys;
      const view = await tx.crossSigning.views(
        localpartOf(user),
        user,
        requester,
      );
      for (const [field, value] of Object.entries(view)) {
        signing[field][user] = value;
        limitEntries(++count, limits.maxkeys);
      }
    }
    const response = {
      device_keys,
      ...signing,
      ...(failures === undefined ? {} : { failures }),
    };
    bounded(response, limits.maxrequestbytes);
    return response;
  });
}
export async function localClaim(
  tenant: Tenant,
  entries: Claim,
  limits: KeyLimits,
  failures?: Json,
): Promise<Json> {
  ownUsers(tenant, entries); // Reject the entire foreign request before consumption.
  return await tenant.tx(async (tx) => {
    const one_time_keys: Record<string, Json> = Object.create(null);
    for (const [user, devices] of entries) {
      for (const [id, algorithm] of Object.entries(devices)) {
        const key = await tx.e2ee.claim(localpartOf(user), id, algorithm);
        if (key !== null) {
          if (!Object.hasOwn(one_time_keys, user)) {
            one_time_keys[user] = Object.create(null);
          }
          one_time_keys[user][id] = key;
        }
      }
    }
    const response = {
      one_time_keys,
      ...(failures === undefined ? {} : { failures }),
    };
    bounded(response, limits.maxrequestbytes); // Roll back all local claims together.
    return response;
  });
}
