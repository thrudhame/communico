// Shared production composition, with no application singleton. Both the home
// endpoint adapter and the facade mailbox use the same ingest/recovery owners.
import type { App } from '#engine/app.ts';
import { acceptRescind } from './invites.ts';
import { productionFetcher } from './fetcher.ts';
import { productionKeyResolver } from './keyresolver.ts';
import type { MembershipSendDeps } from './joins.ts';
import type { TransactionDeps } from './transactions.ts';

export function inviteDependencies(app: App): MembershipSendDeps {
  const signer = app.replica ? app.replica.signer : app.tenant.signer();
  return {
    store: app.store,
    server: app.server,
    signer,
    keys: productionKeyResolver(app.federationKeys),
    self: app.tenant.serverName,
    wake: (destination) => app.sender?.wake(destination),
    requireDirectoryScope: app.replica
      ? () => app.replica!.requireScope('directory')
      : undefined,
    prepareRoomScope: app.replica
      ? (roomId, allowAbsent, localUser) =>
        app.replica!.prepareRoomScope(roomId, allowAbsent, localUser)
      : undefined,
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
