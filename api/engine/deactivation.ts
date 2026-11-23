// Tenant tombstones retain parting work independently of notification/export
// watermarks. Room and OOB owners keep their own immutable departure receipts.
import { invitesOf, rejectInviteRemote } from '#engine/federation/invites.ts';
import { openRoom } from '#engine/room/index.ts';
import { leave } from '#engine/room/membership.ts';
import type { Signer } from '#engine/room/signer.ts';
import { roomsFor } from '#engine/server/read.ts';
import { onProjected } from '#engine/server/project.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';

type Dependencies = {
  store: Store;
  tenant: Tenant;
  prepareSigner(): Promise<Signer>;
  wake(destination: string): void;
  failed(error: unknown): void;
};

export async function runDeactivationWork(
  options: Dependencies,
): Promise<void> {
  const { store, tenant } = options;
  const server = await store.server();
  const pending = await (await store.tenant(tenant.serverName)).query(
    'SELECT w.localpart FROM deactivation_work w JOIN users u ON u.localpart=w.localpart WHERE u.deactivated=1 ORDER BY w.localpart',
  );
  for (const row of pending) {
    const user = '@' + row.localpart + ':' + tenant.serverName;
    for (const membership of await roomsFor(server, user, 'admission')) {
      if (!['join', 'invite', 'knock'].includes(membership.membership)) {
        continue;
      }
      try {
        const room = await openRoom(store, membership.roomId);
        // No server/tenant read occurs inside the room's signing callback.
        const signer = await options.prepareSigner();
        await leave(room, user, signer);
      } catch (error) {
        options.failed(error);
      }
    }
    // This inventory includes out-of-band invites and uncertain knock attempts,
    // not only joined rooms. Rejection commits local departure + remote intent;
    // the existing sender owns remote retries, never this worker.
    for (const invitation of await invitesOf(user, { server })) {
      if (
        !['pending', 'attempting', 'failed-attempt'].includes(invitation.status)
      ) continue;
      try {
        const signer = await options.prepareSigner();
        await rejectInviteRemote(invitation.roomId, user, {
          store,
          server,
          self: tenant.serverName,
          wake: options.wake,
          signer,
        });
      } catch (error) {
        options.failed(error);
      }
    }
    // Keep the root: a later imported room/prejoin can reveal old membership.
    // Already departed rooms and prepared OOB intents cause no new signature.
  }
}

export function startDeactivationWork(
  options: Dependencies & { pollseconds: number },
) {
  let stopped = false, dirty = false;
  let running: Promise<void> | undefined;
  const wake = () => {
    if (stopped) return;
    dirty = true;
    running ??= (async () => {
      try {
        do {
          dirty = false;
          try {
            await runDeactivationWork(options);
          } catch (error) {
            options.failed(error);
          }
          // close stops accepting wakes, not work already accepted by this pass.
        } while (dirty);
      } finally {
        running = undefined;
      }
    })();
  };
  const untenant = onTenantStream((store, name) => {
    if (store === options.store && name === options.tenant.serverName) wake();
  });
  const unproject = onProjected((store) => {
    if (store === options.store) wake();
  });
  const timer = setInterval(wake, options.pollseconds * 1000);
  wake();
  return {
    wake,
    async close() {
      stopped = true;
      clearInterval(timer);
      untenant();
      unproject();
      await running;
    },
  };
}
