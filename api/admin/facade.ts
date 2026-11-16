import type { App } from '#engine/app.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { ConflictSelector } from '#engine/tenant/conflicts.ts';
import { config } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import {
  certificatePin,
  readProtectedFile,
  writeProtectedFile,
} from '#engine/facade/identity.ts';
import { Pairings, pairingStatus } from '#engine/facade/pairing.ts';
import { integer, LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import { AdminError, type Body, type Operation, text } from './protocol.ts';

type Dependencies = {
  role: 'home' | 'facade';
  pairings(): Promise<Pairings>;
  initialize?(): Promise<unknown>;
  status?(): Promise<unknown>;
  changed?(): Promise<void>;
  tenant?(): Promise<Tenant | null>;
};

function conflictSelector(body: Body): ConflictSelector {
  const localpart = text(body, 'localpart');
  switch (body.kind) {
    case 'account-data':
      return {
        kind: body.kind,
        localpart,
        roomId: text(body, 'roomId'),
        type: text(body, 'type'),
      };
    case 'profile':
    case 'push-rules':
      return { kind: body.kind, localpart };
    default:
      throw new AdminError(
        'BAD_REQUEST',
        'expected account-data, profile or push-rules',
      );
  }
}
export function facadeOperations(
  deps: Dependencies,
): Record<string, Operation> {
  const operations: Record<string, Operation> = {
    '/v1/facade/status': async () =>
      deps.status
        ? await deps.status()
        : await (await deps.pairings()).status(),
  };
  const tenant = async () => {
    const owner = await deps.tenant?.();
    if (!owner) {
      throw new AdminError(
        'UNAVAILABLE',
        'tenant recovery data unavailable',
        503,
      );
    }
    return owner;
  };
  operations['/v1/facade/conflicts'] = async (body) => {
    const selector = conflictSelector(body);
    return await (await tenant()).tx((tx) => tx.conflicts.inspect(selector));
  };
  operations['/v1/facade/conflicts/export'] = async (body) => {
    const selector = conflictSelector(body);
    const operationId = text(body, 'operationId');
    const exportfile = text(body, 'exportfile');
    const saved = await (await tenant()).tx((tx) =>
      tx.conflicts.export(selector, operationId)
    );
    try {
      // File I/O happens AFTER the read transaction, never in a retryable body.
      await writeProtectedFile(exportfile, JSON.stringify(saved));
    } catch (error) {
      if (error instanceof Deno.errors.AlreadyExists) {
        throw new AdminError(
          'BAD_REQUEST',
          'conflict export file already exists',
        );
      }
      throw error;
    }
    return { operationId, exportfile };
  };
  if (deps.role === 'home') {
    operations['/v1/facade/pair'] = async (body) => {
      const bundlefile = text(body, 'bundlefile');
      const pairings = await deps.pairings();
      const bundle = await pairings.create({
        node: text(body, 'node'),
        url: text(body, 'url'),
        facadePin: text(body, 'facadePin'),
        expires: integer(body.expires, 1),
        required: [...LINK_CAPABILITIES],
      });
      try {
        await writeProtectedFile(bundlefile, canonicalJson(bundle));
      } catch (error) {
        // A local export failure never leaves an unknown live enrollment.
        await pairings.revoke(bundle.id);
        if (error instanceof Deno.errors.AlreadyExists) {
          throw new AdminError(
            'BAD_REQUEST',
            'pairing bundle file already exists',
          );
        }
        throw error;
      }
      return {
        id: bundle.id,
        node: bundle.node,
        expires: bundle.expires,
        bundlefile,
      };
    };
    operations['/v1/facade/revoke'] = async (body) => {
      const revoked = await (await deps.pairings()).revoke(text(body, 'id'));
      return { id: revoked.body.pairing, revision: revoked.body.revision };
    };
  } else {
    operations['/v1/facade/initialize'] = async () => {
      if (!deps.initialize) {
        throw new AdminError('BAD_REQUEST', 'node initialization unavailable');
      }
      return await deps.initialize();
    };
    operations['/v1/facade/accept'] = async (body) => {
      let bundle: unknown;
      try {
        bundle = JSON.parse(await readProtectedFile(text(body, 'bundlefile')));
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new AdminError('BAD_REQUEST', 'invalid pairing bundle JSON');
        }
        throw error;
      }
      await (await deps.pairings()).accept(bundle);
      await deps.changed?.();
      return { accepted: true };
    };
  }
  return operations;
}

/** Lazy: standalone home never needs facade TLS material merely to start. */
export function homeFacadeOperations(app: App): Record<string, Operation> {
  return facadeOperations({
    role: 'home',
    tenant: () => Promise.resolve(app.tenant),
    status: () => pairingStatus(app.server),
    pairings: async () =>
      new Pairings(
        app.server,
        app.tenant.signer(),
        app.tenant.publicB64,
        certificatePin(await Deno.readTextFile(config().facade.linkcert)),
      ),
  });
}
