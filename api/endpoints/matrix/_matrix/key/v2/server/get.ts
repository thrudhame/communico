import { theApp } from '#engine/app.ts';
import {
  assertFederationEnabled,
  keyDocResponse,
} from '#engine/federation/keydoc.ts';
import { ourKeyDocument } from '#engine/federation/keys.ts';

export default async function () {
  assertFederationEnabled();
  const { tenant } = theApp();
  return keyDocResponse(
    await ourKeyDocument(tenant.signer(), tenant.publicB64),
  );
}
