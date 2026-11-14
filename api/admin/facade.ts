import type { App } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { canonicalJson } from '#engine/canonical.ts';
import {
  certificatePin,
  readProtectedFile,
  writeProtectedFile,
} from '#engine/facade/identity.ts';
import { Pairings, pairingStatus } from '#engine/facade/pairing.ts';
import { integer, LINK_CAPABILITIES } from '#engine/facade/protocol.ts';
import { AdminError, type Operation, text } from './protocol.ts';

type Dependencies = {
  role: 'home' | 'facade';
  pairings(): Promise<Pairings>;
  initialize?(): Promise<unknown>;
  status?(): Promise<unknown>;
  changed?(): Promise<void>;
};
export function facadeOperations(
  deps: Dependencies,
): Record<string, Operation> {
  const operations: Record<string, Operation> = {
    '/v1/facade/status': async () =>
      deps.status
        ? await deps.status()
        : await (await deps.pairings()).status(),
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
