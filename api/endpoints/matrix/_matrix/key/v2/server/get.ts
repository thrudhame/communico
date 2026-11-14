import { theApp } from '#engine/app.ts';
import {
  assertFederationEnabled,
  homeKeyDocument,
  keyDocResponse,
} from '#engine/federation/keydoc.ts';

export default async function () {
  assertFederationEnabled();
  const { tenant, server, replica } = theApp();
  return keyDocResponse(
    replica
      ? await replica.keyDocument()
      : await homeKeyDocument(server, tenant.signer(), tenant.publicB64),
  );
}
