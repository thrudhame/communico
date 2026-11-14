// Composition for thin endpoint adapters; all state belongs to the app.
import { theApp } from '#engine/app.ts';
import type { InviteDeps } from './invites.ts';
import { inviteDependencies, transactionDependencies } from './dependencies.ts';
import type { TransactionDeps } from './transactions.ts';
import type { ServeDeps } from './serve.ts';

export function serveDeps(): ServeDeps {
  const app = theApp();
  return {
    store: app.store,
    server: app.server,
    self: app.tenant.serverName,
    requireScope: app.replica?.requireScope,
  };
}

export function inviteDeps(): InviteDeps {
  return inviteDependencies(theApp());
}

export function transactionDeps(): TransactionDeps {
  return transactionDependencies(theApp());
}
