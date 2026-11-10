// Read-only remote discovery uses the normal gate and signed transport, but
// cannot grow the participation roster merely because someone inspected data.
import type { Database } from '#engine/store/db.ts';
import type { Signer } from '#engine/room/signer.ts';
import { admit } from './gate.ts';
import { type FederationRequest, federationRequest } from './client.ts';

export async function discoveryRequest(
  server: Database,
  signer: Signer,
  request: Omit<FederationRequest, 'method' | 'body'>,
): Promise<unknown> {
  await admit(server, request.destination, {
    kind: 'lookup',
    what: 'read-only discovery',
  });
  return (await federationRequest(server, signer, {
    ...request,
    method: 'GET',
    body: null,
  })).json;
}
