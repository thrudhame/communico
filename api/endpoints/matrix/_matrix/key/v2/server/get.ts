import { theApp } from '#engine/app.ts';
import {
  assertFederationEnabled,
  homeKeyDocument,
  keyDocResponse,
} from '#engine/federation/keydoc.ts';

export default async function () {
  assertFederationEnabled();
  const { tenant, server } = theApp();
  return keyDocResponse(
    await homeKeyDocument(server, tenant.signer(), tenant.publicB64),
  );
}
