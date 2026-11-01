// Composition for thin endpoint adapters; all state belongs to the app.
import { theApp } from '#engine/app.ts';
import { acceptRescind, type InviteDeps } from './invites.ts';
import { productionFetcher } from './fetcher.ts';
import { productionKeyResolver } from './keyresolver.ts';
import type { TransactionDeps } from './transactions.ts';

export function inviteDeps(): InviteDeps {
  const app = theApp();
  const signer = app.tenant.signer();
  return {
    store: app.store,
    server: app.server,
    signer,
    keys: productionKeyResolver(app.server, signer),
    self: app.tenant.serverName,
    wake: (destination) => app.sender?.wake(destination),
  };
}

export function transactionDeps(): TransactionDeps {
  const app = theApp();
  const deps = inviteDeps();
  return {
    store: app.store,
    keys: deps.keys,
    fetcher: productionFetcher(app.server, deps.signer),
    self: deps.self,
    edus: app.federationEdus,
    rescind: (roomId, pdu) => acceptRescind(roomId, pdu, deps),
  };
}
