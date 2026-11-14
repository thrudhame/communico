// Shared production composition, with no application singleton. Both the home
// endpoint adapter and the facade mailbox use the same ingest/recovery owners.
import type { App } from '#engine/app.ts';
import { acceptRescind, type InviteDeps } from './invites.ts';
import { productionFetcher } from './fetcher.ts';
import { productionKeyResolver } from './keyresolver.ts';
import type { TransactionDeps } from './transactions.ts';

export function inviteDependencies(app: App): InviteDeps {
  const signer = app.replica ? app.replica.signer : app.tenant.signer();
  return {
    store: app.store,
    server: app.server,
    signer,
    keys: productionKeyResolver(app.server, signer, app.federationKeys),
    self: app.tenant.serverName,
    wake: (destination) => app.sender?.wake(destination),
  };
}

export function transactionDependencies(app: App): TransactionDeps {
  const deps = inviteDependencies(app);
  return {
    store: app.store,
    keys: deps.keys,
    fetcher: productionFetcher(app.server, deps.signer, app.store),
    self: deps.self,
    edus: app.federationEdus,
    rescind: (roomId, pdu) => acceptRescind(roomId, pdu, deps),
  };
}
