// Home-only connection manager. Pairing registry owns peers, configuration only
// selects node IDs. A stalled peer never serializes another peer's enrollment.
import type { App } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { capabilities } from './capabilities.ts';
import { exportKeyRoster, refreshRetiredKeyDocument } from './control.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { openJournalClient } from './client.ts';
import { certificatePin, readProtectedFile } from './identity.ts';
import { Journal } from './journal.ts';
import { enrollLink } from './link.ts';
import { Pairings } from './pairing.ts';
import { RoomReplicas, startRoomExports } from './replication.ts';
import { startPublicExports } from './public.ts';
import { startDirectoryExports } from './directory.ts';
import { HomeIngress } from './drain.ts';
import { HomeEgress } from './home-egress.ts';
import { dispatchBatch } from '#engine/federation/sender.ts';
import { transactionDependencies } from '#engine/federation/dependencies.ts';
import {
  LINK_SUPPORTED,
  LinkError,
  object,
  type Stream,
  text,
} from './protocol.ts';
import { loadLinkTls } from './transport.ts';
import { startHomeLinkWorker } from './worker.ts';
import {
  AccountSnapshots,
  exportAccountAuth,
  startAccountExports,
} from './accounts.ts';
import { exportOwnerControl } from './ownership.ts';
import { DomainOperations } from './domain.ts';
import { DeviceOperations, isKeyStream } from './devices.ts';
import { isToDeviceStream, ToDeviceOperations } from './todevice.ts';
import { MembershipOperations, startMembershipExports } from './membership.ts';
import { ActivityExchange } from './activity.ts';

export async function startHomeLinks(
  app: App,
  apply: (peer: string, stream: Stream) => Promise<boolean> = () =>
    Promise.resolve(false),
) {
  const settings = config().facade;
  if (!capabilities(config().server.role).service('link-client')) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'facade cannot initiate a link',
      403,
    );
  }
  await refreshRetiredKeyDocument(
    app.server,
    app.tenant.signer(),
    app.tenant.publicB64,
  );
  if (!settings.nodes.length) {
    if (
      (await app.server.query('SELECT 1 FROM facade_egress_routes LIMIT 1'))
        .length
    ) {
      throw new LinkError(
        'LINK_UNAVAILABLE',
        'retained destination egress ownership requires its configured link',
        503,
      );
    }
    return { dispatch: undefined, close: () => Promise.resolve() };
  }
  const tls = await loadLinkTls(settings);
  const pairings = new Pairings(
    app.server,
    app.tenant.signer(),
    app.tenant.publicB64,
    certificatePin(tls.cert),
  );
  const journal = new Journal(app.server, LINK_SUPPORTED);
  const controller = new AbortController();
  const workers = new Map<string, ReturnType<typeof startHomeLinkWorker>>();
  const exports = new Map<string, ReturnType<typeof startRoomExports>>();
  const publicExports = new Map<
    string,
    ReturnType<typeof startPublicExports>
  >();
  const jobs = new Map<string, Promise<void>>();
  const authExports = new Map<string, ReturnType<typeof startAccountExports>>();
  const keyExports = new Map<string, ReturnType<typeof startAccountExports>>();
  const toDeviceExports = new Map<
    string,
    ReturnType<typeof startAccountExports>
  >();
  const accounts = new AccountSnapshots(app.store, app.tenant, pairings);
  const membershipExports = new Map<
    string,
    ReturnType<typeof startAccountExports>
  >();
  const memberships = new MembershipOperations(app.store, app.tenant, pairings);
  const domains = new DomainOperations(app.store, app.tenant, pairings);
  const devices = new DeviceOperations(app.store, app.tenant, pairings);
  const toDevice = new ToDeviceOperations(app.store, app.tenant, pairings);
  const roomReplicas = new RoomReplicas(
    app.store,
    pairings,
    app.tenant.serverName,
    productionKeyResolver(app.federationKeys),
  );
  const collectKeySignature = async (
    keyId: string,
    document: import('#engine/federation/keys.ts').KeyDoc,
  ) => {
    for (const binding of await pairings.status()) {
      if (binding.state !== 'paired') continue;
      const connection = await pairings.connection(binding.id);
      if (connection.grant?.body.transcript.body.key.keyId !== keyId) continue;
      const client = await openJournalClient(pairings, binding.id, tls);
      return await client.signKeyDocument(document, controller.signal);
    }
    throw new LinkError(
      'LINK_UNAVAILABLE',
      'approved facade signing link unavailable',
      503,
    );
  };
  const directoryExports = new Map<
    string,
    ReturnType<typeof startDirectoryExports>
  >();
  const egress = new HomeEgress(
    app.server,
    pairings,
    journal,
    settings.nodes,
    settings.outbound as 'direct' | 'facade',
    (envelope) => dispatchBatch(app.server, app.tenant.signer(), envelope),
    () => {
      for (const worker of workers.values()) worker.wake();
    },
  );
  const failed = (node: string, error: unknown) => {
    if (!controller.signal.aborted) {
      console.error(
        'facade link:',
        node,
        error instanceof LinkError ? error.code : 'LINK_UNAVAILABLE',
      );
    }
  };
  async function reconcile(id: string, node: string) {
    const peer = await pairings.connection(id);
    if (peer.state === 'paired' && workers.has(id)) {
      await exportKeyRoster(
        app.store,
        app.tenant,
        node,
        id,
        collectKeySignature,
        undefined,
        (error) => failed(node, error),
      );
      exports.get(id)?.wake();
      publicExports.get(id)?.wake();
      directoryExports.get(id)?.wake();
      authExports.get(id)?.wake();
      keyExports.get(id)?.wake();
      toDeviceExports.get(id)?.wake();
      membershipExports.get(id)?.wake();
      return;
    }
    await exports.get(id)?.close();
    exports.delete(id);
    await publicExports.get(id)?.close();
    publicExports.delete(id);
    await directoryExports.get(id)?.close();
    directoryExports.delete(id);
    await authExports.get(id)?.close();
    authExports.delete(id);
    await keyExports.get(id)?.close();
    keyExports.delete(id);
    await toDeviceExports.get(id)?.close();
    toDeviceExports.delete(id);
    await membershipExports.get(id)?.close();
    membershipExports.delete(id);
    await workers.get(id)?.close();
    workers.delete(id);
    let secret: string | undefined;
    if (peer.state !== 'revoked' && !peer.grant && !peer.transcript) {
      if (!settings.pairfile) {
        throw new LinkError(
          'LINK_UNPAIRED',
          'pending enrollment needs its protected bundle',
          503,
        );
      }
      const bundle = object(
        JSON.parse(await readProtectedFile(settings.pairfile)),
      );
      if (bundle.id !== id) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'configured bundle belongs to another pairing',
          403,
        );
      }
      secret = text(bundle.secret);
    }
    await enrollLink(pairings, id, tls, secret, controller.signal);
    if (peer.state === 'revoked' || controller.signal.aborted) return;
    await exportKeyRoster(
      app.store,
      app.tenant,
      node,
      id,
      collectKeySignature,
      undefined,
      (error) => failed(node, error),
    );
    const client = await openJournalClient(pairings, id, tls);
    if (controller.signal.aborted) return;
    if (settings.phase === 'f2') {
      await exportOwnerControl(app.store, app.tenant, pairings, id);
    }
    const ingress = new HomeIngress(app.server, {
      peer: node,
      pairing: id,
      pairings,
      transaction: transactionDependencies(app),
      toDevice: (origin, raw, receipt) =>
        toDevice.ingress(origin, raw, receipt, id),
    });
    workers.set(
      id,
      startHomeLinkWorker({
        client,
        journal,
        activity: settings.phase === 'f2'
          ? new ActivityExchange(app.store, app.tenant, pairings)
          : undefined,
        limits: {
          maxItems: settings.batchmaxitems,
          maxBytes: settings.batchmaxbytes,
        },
        // The configuration owner already validates this enum at load.
        notify: settings.notify as 'websocket' | 'sse' | 'poll',
        pollseconds: settings.pollseconds,
        reconnectmaxseconds: settings.reconnectmaxseconds,
        apply: (stream) =>
          stream.stream.startsWith('ingress:')
            ? ingress.apply(journal, stream)
            : settings.phase === 'f2' && stream.stream.startsWith('authority:')
            ? accounts.applyFromFacade(journal, id, stream)
            : settings.phase === 'f2' && stream.stream.startsWith('domain:')
            ? domains.apply(journal, stream, id)
            : settings.phase === 'f2' && isKeyStream(stream)
            ? devices.apply(journal, stream, id)
            : settings.phase === 'f2' && isToDeviceStream(stream)
            ? toDevice.apply(journal, stream, id)
            : settings.phase === 'f2' && stream.stream.startsWith('membership:')
            ? memberships.apply(
              journal,
              stream,
              productionKeyResolver(app.federationKeys),
              id,
            )
            : settings.phase === 'f2' && stream.stream.startsWith('room:')
            ? roomReplicas.apply(journal, stream, id)
            : apply(node, stream),
        failed: (error) => failed(node, error),
        acknowledged: (stream) => {
          if (stream.stream.startsWith('egress:')) {
            app.sender?.wake(stream.stream.slice('egress:'.length));
          }
        },
      }),
    );
    const rooms = startRoomExports({
      store: app.store,
      self: app.tenant.serverName,
      peer: node,
      pairing: id,
      version: settings.phase === 'f2' ? 2 : 1,
      changed: () => workers.get(id)?.wake(),
      failed: (error) => failed(node, error),
    });
    exports.set(id, rooms);
    rooms.wake();
    const users = startPublicExports({
      store: app.store,
      tenant: app.tenant,
      peer: node,
      pairing: id,
      changed: () => workers.get(id)?.wake(),
      failed: (error) => failed(node, error),
    });
    publicExports.set(id, users);
    users.wake();
    const directory = startDirectoryExports({
      store: app.store,
      tenant: app.tenant,
      peer: node,
      pairing: id,
      version: settings.phase === 'f2' ? 2 : 1,
      changed: () => workers.get(id)?.wake(),
      failed: (error) => failed(node, error),
    });
    directoryExports.set(id, directory);
    directory.wake();
    if (settings.phase === 'f2') {
      authExports.set(
        id,
        startAccountExports({
          store: app.store,
          tenant: app.tenant,
          pollseconds: settings.pollseconds,
          users: () => app.tenant.tx((tx) => tx.publicReplica.users()),
          emit: async (localpart) => {
            await exportAccountAuth(
              app.store,
              app.tenant,
              pairings,
              id,
              localpart,
              settings.replicatecredentials,
            );
            await domains.bootstrap(localpart, id);
          },
          changed: () => workers.get(id)?.wake(),
          failed: (error) => failed(node, error),
        }),
      );
      // Keys and account-data/receipt recovery have independent progress. A
      // failed domain export cannot hold a verified key or revocation suffix.
      keyExports.set(
        id,
        startAccountExports({
          store: app.store,
          tenant: app.tenant,
          pollseconds: settings.pollseconds,
          users: () => app.tenant.tx((tx) => tx.publicReplica.users()),
          emit: async (localpart) => {
            await devices.exportChanges(localpart, id);
            return await devices.bootstrap(localpart, id);
          },
          changed: () => workers.get(id)?.wake(),
          failed: (error) => failed(node, error),
        }),
      );
      toDeviceExports.set(
        id,
        startAccountExports({
          store: app.store,
          tenant: app.tenant,
          pollseconds: settings.pollseconds,
          users: () => app.tenant.tx((tx) => tx.publicReplica.users()),
          emit: (localpart) => toDevice.export(localpart, id),
          changed: () => workers.get(id)?.wake(),
          failed: (error) => failed(node, error),
        }),
      );
      membershipExports.set(
        id,
        startMembershipExports({
          store: app.store,
          server: app.server,
          tenant: app.tenant,
          pollseconds: settings.pollseconds,
          users: () => app.tenant.tx((tx) => tx.publicReplica.users()),
          emit: (localpart) => memberships.bootstrap(localpart, id),
          // A successful empty bootstrap is also a directory dependency. Wake its
          // retry independently of whether a membership journal record was added.
          changed: () => {
            directoryExports.get(id)?.wake();
            workers.get(id)?.wake();
          },
          failed: (error) => failed(node, error),
        }),
      );
    }
  }
  let scanning: Promise<void> | undefined;
  const scan = () =>
    scanning ??= (async () => {
      try {
        await refreshRetiredKeyDocument(
          app.server,
          app.tenant.signer(),
          app.tenant.publicB64,
        );
        for (const peer of await pairings.status()) {
          if (controller.signal.aborted) break;
          if (!settings.nodes.includes(peer.node) || jobs.has(peer.id)) {
            continue;
          }
          const job = reconcile(peer.id, peer.node).catch((error) =>
            failed(peer.node, error)
          );
          jobs.set(peer.id, job);
          void job.finally(() => jobs.delete(peer.id));
        }
      } catch (error) {
        failed('registry', error);
      } finally {
        scanning = undefined;
      }
    })();
  const timer = setInterval(() => void scan(), settings.pollseconds * 1000);
  await scan();
  let closed: Promise<void> | undefined;
  return {
    dispatch: egress.dispatch.bind(egress),
    close() {
      return closed ??= (async () => {
        clearInterval(timer);
        controller.abort();
        await scanning;
        await Promise.all(jobs.values());
        await Promise.all(
          [...authExports.values()].map((accounts) => accounts.close()),
        );
        await Promise.all(
          [...keyExports.values()].map((keys) => keys.close()),
        );
        await Promise.all(
          [...toDeviceExports.values()].map((deliveries) => deliveries.close()),
        );
        await Promise.all(
          [...membershipExports.values()].map((memberships) =>
            memberships.close()
          ),
        );
        await Promise.all([...exports.values()].map((rooms) => rooms.close()));
        await Promise.all(
          [...publicExports.values()].map((users) => users.close()),
        );
        await Promise.all(
          [...directoryExports.values()].map((directory) => directory.close()),
        );
        await Promise.all(
          [...workers.values()].map((worker) => worker.close()),
        );
      })();
    },
  };
}
