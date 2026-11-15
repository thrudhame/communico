import { theApp } from '#engine/app.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { captureErasureCuts } from '#engine/tenant/erasure.ts';

export async function deactivateAccount(
  localpart: string,
  erase: boolean,
): Promise<void> {
  const app = theApp();
  await deactivateUser(
    app.tenant,
    localpart,
    erase ? await captureErasureCuts(app.store) : undefined,
  );
}
