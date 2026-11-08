import { theApp } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import { localpartOf } from '#engine/ids.ts';
import { signingUpload } from '#engine/e2ee-signing.ts';
import { needsSigningAuth } from '#engine/tenant/cross-signing.ts';
import { PASSWORD_FLOWS, requireUia } from '#engine/tenant/uia.ts';
import { object } from '#engine/tenant/e2ee.ts';
import { signatureTargets } from '#engine/tenant/key-signatures.ts';

export async function uploadSignatures(user: string, body: unknown) {
  const targets = signatureTargets(body, config().e2ee);
  return await theApp().tenant.tx((tx) =>
    tx.keySignatures.upload(localpartOf(user), user, targets)
  );
}

export async function uploadSigningKeys(
  user: string,
  body: unknown,
): Promise<void> {
  const tenant = theApp().tenant, localpart = localpartOf(user);
  const input = signingUpload(body, user, config().e2ee);
  const old = await tenant.tx((tx) => tx.crossSigning.state(localpart));
  const authenticated = needsSigningAuth(old, input);
  if (authenticated) {
    await requireUia(tenant, {
      body: object(body, 'body'),
      caller: user,
      flows: PASSWORD_FLOWS,
    });
  }
  await tenant.tx((tx) =>
    tx.crossSigning.upload(
      localpart,
      user,
      input,
      canonicalJson(old),
      authenticated,
    )
  );
}
