// C-S key composition. The tenant owns consuming transactions and public keys.
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

function requests(value: unknown, field: string): [string, unknown][] {
  bounded(value, config().e2ee.maxrequestbytes);
  const entries = Object.entries(object(object(value, 'body')[field], field));
  limitEntries(entries.length, config().e2ee.maxkeys);
  for (const [user] of entries) {
    if (!/^@[^:]+:.+$/.test(user)) {
      throw new MatrixError(400, 'M_BAD_JSON', 'invalid user ID');
    }
  }
  return entries;
}
export async function queryKeys(
  requester: string,
  body: unknown,
): Promise<Json> {
  const limits = config().e2ee;
  const entries = requests(body, 'device_keys');
  const parsed = entries.map(([user, value]) => {
    if (!Array.isArray(value) || value.some((id) => typeof id !== 'string')) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'device IDs must be an array of strings',
      );
    }
    return [user, value as string[]] as const;
  });
  limitEntries(
    parsed.reduce((n, [, ids]) => n + Math.max(1, ids.length), 0),
    config().e2ee.maxkeys,
  );
  const tenant = theApp().tenant;
  return await tenant.tx(async (tx) => {
    const result: Json = Object.create(null),
      failures: Json = Object.create(null);
    let count = 0;
    for (const [user, ids] of parsed) {
      const origin = domainOf(user);
      if (origin === tenant.serverName) {
        result[user] = await tx.e2ee.query(
          localpartOf(user),
          ids,
          requester,
          user,
          limits.maxkeys,
        );
        count += Object.keys(result[user] as Json).length;
        limitEntries(count, limits.maxkeys);
      } else {
        failures[origin] = {
          errcode: 'M_UNAVAILABLE',
          error: 'remote keys unavailable',
        };
      }
    }
    const response = { device_keys: result, failures };
    bounded(response, limits.maxrequestbytes);
    return response;
  });
}

export async function claimKeys(body: unknown): Promise<Json> {
  const entries = requests(body, 'one_time_keys');
  const parsed: [string, string, string][] = [];
  for (const [user, value] of entries) {
    for (
      const [id, algorithm] of Object.entries(
        object(value, 'device algorithms'),
      )
    ) {
      if (
        !id.length || typeof algorithm !== 'string' || !algorithm.length
      ) throw new MatrixError(400, 'M_BAD_JSON', 'invalid device algorithm');
      parsed.push([user, id, algorithm]);
    }
  }
  const limits = config().e2ee;
  limitEntries(parsed.length, limits.maxkeys);
  const tenant = theApp().tenant;
  return await tenant.tx(async (tx) => {
    const result: Record<string, Json> = Object.create(null),
      failures: Json = Object.create(null);
    for (const [user, id, algorithm] of parsed) {
      const origin = domainOf(user);
      if (origin !== tenant.serverName) {
        failures[origin] = {
          errcode: 'M_UNAVAILABLE',
          error: 'remote keys unavailable',
        };
        continue;
      }
      const key = await tx.e2ee.claim(localpartOf(user), id, algorithm);
      if (key !== null) {
        if (!Object.hasOwn(result, user)) result[user] = Object.create(null);
        result[user][id] = key;
      }
    }
    const response = { one_time_keys: result, failures };
    bounded(response, limits.maxrequestbytes); // Throw rolls back every consuming claim.
    return response;
  });
}
