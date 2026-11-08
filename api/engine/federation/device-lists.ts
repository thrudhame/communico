// Inbound device-list acceptance and bounded single-flight snapshot recovery.
import { config } from '#engine/config.ts';
import { deviceDelta, remoteDeviceSnapshot } from '#engine/e2ee-remote.ts';
import { domainOf } from '#engine/ids.ts';
import { abortable } from '#engine/net/abort.ts';
import type { Database } from '#engine/store/db.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import {
  acceptDeviceDelta,
  installDeviceSnapshot,
  recoveryCut,
} from '#engine/server/remote-devices.ts';
import { federationRequest } from './client.ts';
import { type EduState, PermanentEduRefusal } from './edus.ts';
import { admit } from './gate.ts';

export type DeviceListService = {
  recover(user: string): Promise<void>;
  start(): void;
  stop(): Promise<void>;
};

export function deviceListService(
  db: Database,
  tenant: Tenant,
  edus: EduState,
): DeviceListService {
  const inFlight = new Map<string, Promise<void>>();
  const shutdown = new AbortController();
  let timer: ReturnType<typeof setInterval> | undefined;
  let scan: Promise<void> | undefined;

  async function recover(user: string): Promise<void> {
    const current = inFlight.get(user);
    if (current !== undefined) return await current;
    const run = (async () => {
      const cut = await recoveryCut(db, user);
      if (cut === null || shutdown.signal.aborted) return;
      const observers = await db.query(
        "SELECT observer FROM device_tracking WHERE subject=? AND scope='keys' AND end_seq IS NULL",
        [user],
      );
      const observer = observers.map((r) => String(r.observer)).find((id) =>
        domainOf(id) === tenant.serverName
      );
      if (observer === undefined) return;
      const signal = AbortSignal.any([
        shutdown.signal,
        AbortSignal.timeout(config().federation.timeoutms),
      ]);
      try {
        await abortable(
          signal,
          () =>
            admit(db, domainOf(user)!, {
              kind: 'outbound',
              user: observer,
              what: 'recover device list',
            }),
        );
        const response = await federationRequest(db, tenant.signer(), {
          destination: domainOf(user)!,
          method: 'GET',
          body: null,
          path: '/_matrix/federation/v1/user/devices/' +
            encodeURIComponent(user),
          maxBytes: config().e2ee.maxrequestbytes,
          signal,
        });
        signal.throwIfAborted();
        const snapshot = remoteDeviceSnapshot(
          response.json,
          user,
          config().e2ee,
        );
        if (await installDeviceSnapshot(db, cut, snapshot, config().e2ee)) {
          return;
        }
      } catch (error) {
        if (!shutdown.signal.aborted) {
          console.error(
            `device-list[${user}]: snapshot remains stale: ${String(error)}`,
          );
        }
      }
      if (shutdown.signal.aborted) return;
      const now = Date.now(), fed = config().federation;
      await db.tx(async (tx) => {
        const row = (await tx.query(
          'SELECT failures FROM remote_device_users WHERE user_id=? AND stale=1',
          [user],
        ))[0];
        if (!row) return;
        const failures = Math.min(20, Number(row.failures) + 1);
        const delay = Math.min(
          fed.backoffmaxmillihours,
          fed.backoffstartmillihours * 2 ** (failures - 1),
        ) * 3600;
        await tx.execute(
          'UPDATE remote_device_users SET failures=?,retry_at=? WHERE user_id=? AND stale=1',
          [failures, now + delay, user],
        );
      });
    })();
    inFlight.set(user, run);
    try {
      await run;
    } finally {
      if (inFlight.get(user) === run) inFlight.delete(user);
    }
  }
  function wake(): void {
    if (timer === undefined || scan !== undefined || shutdown.signal.aborted) {
      return;
    }
    scan = (async () => {
      const due = await db.query(
        "SELECT u.user_id FROM remote_device_users u WHERE u.stale=1 AND u.retry_at<=? AND EXISTS (SELECT 1 FROM device_tracking t WHERE t.subject=u.user_id AND t.scope='keys' AND t.end_seq IS NULL AND substr(t.observer,instr(t.observer,':')+1)=?) ORDER BY u.retry_at,u.user_id LIMIT 4",
        [Date.now(), tenant.serverName],
      );
      await Promise.all(due.map((r) => recover(String(r.user_id))));
    })().catch((e) => console.error(`device-list recovery: ${String(e)}`))
      .finally(() => {
        scan = undefined;
      });
  }
  edus.register('m.device_list_update', async (origin, raw) => {
    if (
      typeof raw.user_id !== 'string' || domainOf(raw.user_id) !== origin ||
      origin === tenant.serverName
    ) return;
    const peers = await db.query(
      "SELECT observer FROM device_tracking WHERE subject=? AND scope='keys' AND end_seq IS NULL",
      [raw.user_id],
    );
    if (
      !peers.some((r) => domainOf(String(r.observer)) === tenant.serverName)
    ) return;
    let delta;
    try {
      delta = deviceDelta(raw, config().e2ee);
    } catch (e) {
      throw new PermanentEduRefusal('M_BAD_JSON', String(e));
    }
    await acceptDeviceDelta(db, delta, config().e2ee);
    wake();
  }, true);
  return {
    recover,
    start: () => {
      if (timer === undefined && !shutdown.signal.aborted) {
        timer = setInterval(wake, 1000);
        wake();
      }
    },
    stop: async () => {
      clearInterval(timer);
      timer = undefined;
      shutdown.abort();
      await scan;
      await Promise.allSettled(inFlight.values());
    },
  };
}
