import { config } from '#engine/config.ts';
import { splitId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Tenant } from '#engine/tenant/index.ts';

/** Authorization precedes account reads. Connection metadata is not collected. */
export async function whois(tenant: Tenant, requester: string, user: string) {
  if (requester !== user && !config().admin.users.includes(requester)) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'not permitted to inspect this user',
    );
  }
  const target = splitId(user);
  if (!user.startsWith('@') || target.server !== tenant.serverName) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'can only inspect a local user',
    );
  }
  return await tenant.tx(async (tx) => {
    const devices: Record<string, { sessions: { connections: never[] }[] }> =
      Object.create(null);
    for (const device of await tx.devices.ofUser(target.localpart)) {
      devices[device.device_id] = { sessions: [] };
    }
    for (const token of await tx.tokens.ofUser(target.localpart)) {
      const key = token.device_id === null ? '' : token.device_id;
      const device = devices[key] ??= { sessions: [] };
      device.sessions.push({ connections: [] });
    }
    return { user_id: user, devices };
  });
}
