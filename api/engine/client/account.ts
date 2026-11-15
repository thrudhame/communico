import { theApp } from '#engine/app.ts';
import { deactivateUser } from '#engine/tenant/users.ts';
import { captureErasureCuts } from '#engine/tenant/erasure.ts';
import type { UiaAuthorization } from '#engine/tenant/uia.ts';

export async function deactivateAccount(
  localpart: string,
  erase: boolean,
  authorization?: UiaAuthorization,
): Promise<void> {
  const app = theApp();
  await deactivateUser(
    app.tenant,
    localpart,
    erase ? await captureErasureCuts(app.store) : undefined,
    authorization,
  );
}
