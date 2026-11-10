import { theApp } from '#engine/app.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { openRoom } from '#engine/room/index.ts';
import type { ErasureCut } from '#engine/room/state.ts';

export async function deactivateAccount(
  localpart: string,
  erase: boolean,
): Promise<void> {
  const app = theApp();
  const cuts: Record<string, ErasureCut> = {};
  if (erase) {
    for (const id of await app.store.rooms()) {
      const room = await openRoom(app.store, id);
      cuts[id] = await room.tx((tx) => tx.state.erasureCut());
    }
  }
  await deactivateUser(app.tenant, localpart, erase ? cuts : undefined);
}
