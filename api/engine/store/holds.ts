import { AsyncLocalStorage } from 'node:async_hooks';

type Scope = {
  parent?: Scope;
  active: number;
};

const scopes = new AsyncLocalStorage<Scope>();

export function storageScope<T>(fn: () => Promise<T>): Promise<T> {
  return scopes.run({ parent: scopes.getStore(), active: 0 }, fn);
}

// Capture the caller's scope, not the context of whichever release wakes it.
export function storageHold(): () => () => void {
  const scope = scopes.getStore();
  return () => {
    if (scope) scope.active++;
    return () => {
      if (scope) scope.active--;
    };
  };
}

export function storageHeld(): boolean {
  for (let scope = scopes.getStore(); scope; scope = scope.parent) {
    if (scope.active !== 0) return true;
  }
  return false;
}

export function withStorageHold<T>(fn: () => Promise<T>): Promise<T> {
  return storageScope(async () => {
    const release = storageHold()();
    try {
      return await fn();
    } finally {
      release();
    }
  });
}
