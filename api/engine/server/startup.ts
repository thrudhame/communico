// api/engine/server/startup.ts — the store startup hook (R12, plan §2
// row 4): discovery, then project() for every registered room until each
// watermark equals its room's last change position. installServerHooks is
// explicit: the composition root (stage 5) and the tests call it; without
// it the room writes stand alone and a later startup catches up.
import { setRoomHooks } from '#engine/room/hooks.ts';
import { project } from '#engine/server/project.ts';
import { discover, listRooms, registerRoom } from '#engine/server/registry.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { setTenantProjector } from '#engine/tenant/hooks.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { reconcileDeviceSubscriptions } from '#engine/server/device-federation.ts';
import type { Store } from '#engine/store/index.ts';
import { onStartup, type StartupStore } from '#engine/store/watermark.ts';
import { installJoinAdmission } from '#engine/server/join-attempts.ts';

export function installServerHooks(): void {
  setRoomHooks({ project, register: registerRoom });
  setTenantProjector(projectTenant);
  onStartup(recoverServer);
}

export async function recoverServer(store: StartupStore): Promise<void> {
  const concrete = store as Store;
  const server = await concrete.server();
  // A store opened without the server schema (engine tests) has nothing
  // to roll forward.
  const version = await server.query(
    `SELECT v FROM meta WHERE k = 'schema_version'`,
  );
  if (
    version.length !== 1 || version[0].v !== String(serverSchema.version)
  ) {
    return;
  }
  installJoinAdmission(concrete);
  await discover(concrete);
  // A completed unlink can precede deletion of its now-orphaned watermark.
  await server.execute(
    "DELETE FROM watermarks WHERE source LIKE 'room:%' AND NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = substr(watermarks.source,6))",
  );
  await server.execute(
    "DELETE FROM watermarks WHERE source LIKE 'push-context:%' AND NOT EXISTS (SELECT 1 FROM rooms WHERE room_id = substr(watermarks.source,14))",
  );
  for (const roomId of await listRooms(concrete)) {
    await project(concrete, roomId);
  }
  for (const tenant of await concrete.tenants()) {
    await projectTenant(concrete, tenant);
  }
  // Supported upgrades can have published relationships before the federation
  // subscription tables exist. Seed at the projected cut, once and idempotently.
  const localServers = await concrete.tenants();
  await server.tx(async (tx) => {
    const subjects = (await tx.query(
      "SELECT DISTINCT subject FROM device_tracking WHERE scope='keys' AND end_seq IS NULL",
    )).map((r) => String(r.subject));
    await reconcileDeviceSubscriptions(tx, subjects, localServers);
  });
}
