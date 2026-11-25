// Composition for thin endpoint adapters; all state belongs to the app.
import { theApp } from '#engine/app.ts';
import type { MembershipSendDeps } from './joins.ts';
import { inviteDependencies, transactionDependencies } from './dependencies.ts';
import type { TransactionDeps } from './transactions.ts';
import type { ServeDeps } from './serve.ts';

export function serveDeps(signal?: AbortSignal): ServeDeps {
  const app = theApp();
  const withScopes = app.replica?.withCurrentScopes;
  return {
    store: app.store,
    server: app.server,
    self: app.tenant.serverName,
    requireScope: app.replica &&
      ((scope) => app.replica!.requireScope(scope, false, signal)),
    withCurrentScopes: withScopes && signal
      ? (read) => withScopes(read, signal)
      : undefined,
  };
}

export function inviteDeps(signal?: AbortSignal): MembershipSendDeps {
  return inviteDependencies(theApp(), signal);
}

export function transactionDeps(): TransactionDeps {
  return transactionDependencies(theApp());
}
