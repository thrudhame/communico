// Independent node composition: no application singleton, home tenant genesis,
// public Matrix listener, or home-only worker is needed for local enrollment.
import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { splitId } from '#engine/ids.ts';
import { drainResources } from '#engine/lifetime.ts';
import { MediaCache } from '#engine/media/cache.ts';
import { MediaEgress } from './media-egress.ts';
import { ContactObservations } from '#engine/federation/pending-contacts.ts';
import { inboxFailure, workerFailure } from '#engine/request-diagnostics.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { openRoom, roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import {
  openStore,
  type Store,
  type StoreConfig,
} from '#engine/store/index.ts';
import { Capacity } from '#engine/store/capacity.ts';
import {
  isStoragePressure,
  StoragePressureError,
} from '#engine/store/pressure.ts';
import { type Tenant, tenantSchema } from '#engine/tenant/index.ts';
import { capabilities } from './capabilities.ts';
import { FacadeKeys } from './control.ts';
import {
  certificatePin,
  enrolledTenant,
  initializeNode,
  loadNode,
  type NodeIdentity,
  readProtectedFile,
} from './identity.ts';
import { Journal } from './journal.ts';
import { linkHandler } from './link.ts';
import { ActivityExchange } from './activity.ts';
import { NoticeHub } from './notices.ts';
import { Pairings, pairingStatus } from './pairing.ts';
import { RoomReplicas, startRoomExports } from './replication.ts';
import { replicationProgress } from './progress.ts';
import { PublicReplicas } from './public.ts';
import { DirectoryReplicas } from './directory.ts';
import { ReplicaReadiness } from './readiness.ts';
import { LINK_SUPPORTED, LinkError } from './protocol.ts';
import { OwnerControls } from './ownership.ts';
import { bindRole } from './role.ts';
import { loadLinkTls } from './transport.ts';
import { startInboxWorker } from './worker.ts';
import { Mailbox } from './mailbox.ts';
import { acceptIngressEdu } from './ingress-edus.ts';
import type { TransactionDeps } from '#engine/federation/transactions.ts';
import type { Stream } from './protocol.ts';
import { EgressOwner } from './egress.ts';
import {
  dispatchBatch,
  type Sender,
  startSender,
} from '#engine/federation/sender.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { startNotificationHistory } from '#engine/server/notification-history.ts';
import { type PushSender, startPushSender } from '#engine/push/sender.ts';
import { DelayedEvents } from '#engine/delayed-events.ts';
import {
  AccountSnapshots,
  exportSessionAuthority,
  startAccountExports,
} from './accounts.ts';
import { AuthLinkHealth, FacadeAuth } from './auth.ts';
import { startDeactivationWork } from '#engine/deactivation.ts';
import { startProfileFanout } from '#engine/profile-fanout.ts';
import { DomainOperations } from './domain.ts';
import { DeviceOperations, isKeyStream } from './devices.ts';
import { isToDeviceStream, ToDeviceOperations } from './todevice.ts';
import { MembershipOperations, startMembershipExports } from './membership.ts';
import {
  type InviteDeps,
  inviteIntentProvider,
} from '#engine/federation/invites.ts';
import { joinCleanupProvider } from '#engine/federation/join-cleanup.ts';
import type { EduState } from '#engine/federation/edus.ts';
import {
  type DeviceListService,
  deviceListService,
} from '#engine/federation/device-lists.ts';

export async function openFacadeRuntime(
  storeConfig: StoreConfig = config().store,
  apply: (journal: Journal, stream: Stream) => Promise<boolean> = () =>
    Promise.resolve(false),
) {
  const settings = config().facade;
  const caps = capabilities(config().server.role, settings.phase);
  const authHealth = new AuthLinkHealth(settings);
  const readiness = new ReplicaReadiness(authHealth);
  if (!caps.service('link-server')) {
    throw new LinkError(
      'LINK_IDENTITY_MISMATCH',
      'home cannot run a facade listener',
      403,
    );
  }
  const tls = await loadLinkTls(settings);
  const pin = certificatePin(tls.cert);
  const identity = {
    role: 'facade' as const,
    server: serverName(),
    node: settings.nodeid,
  };
  const cap = settings.storagebudgetbytes;
  const mediaRoot = config().media.root;
  const capacity = new Capacity(
    [storeConfig.dir, mediaRoot],
    cap === -1 ? undefined : cap === 0 ? null : cap,
  );
  // openStore runs this after the server schema check and before recovery. Even
  // a facade with no media routes owns its verified, reclaimable cache.
  let prepared!: {
    binding: Awaited<ReturnType<typeof bindRole>>;
    server: Awaited<ReturnType<Store['server']>>;
    mediaCache: MediaCache;
    mediaEgress: MediaEgress;
  };
  const store = await openStore(storeConfig, {
    schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    beforeStartup: async (store) => {
      const binding = await bindRole(store, identity);
      const server = await store.server();
      const mediaCache = new MediaCache(
        server,
        mediaRoot,
        config().media.maxvariants,
        capacity,
      );
      const mediaEgress = new MediaEgress(server, settings.homecidrs);
      prepared = { binding, server, mediaCache, mediaEgress };
      await mediaEgress.load();
      await mediaCache.start({ inventoryOnly: true });
    },
    capacityOwner: capacity,
  }).catch(async (error: unknown) => {
    // Inventory-only cache teardown unregisters entries without using the DB,
    // which openStore has already closed if a recovery hook failed.
    await prepared?.mediaCache.close();
    if (isStoragePressure(error)) {
      throw new StoragePressureError(
        error,
        'Facade startup blocked by storage pressure. Cache reclamation requires a readable database and verified identity and cache index. Free filesystem space or increase the configured storage budget as appropriate, then retry.',
      );
    }
    throw error;
  });
  const { binding, server, mediaCache, mediaEgress } = prepared;
  const journal = new Journal(
    server,
    LINK_SUPPORTED,
    (peer, stream) =>
      peer === 'home' && stream.source === 'home'
        ? readiness.receiving(stream.incarnation, stream.stream)
        : undefined,
  );
  const notices = new NoticeHub();
  let node: NodeIdentity | undefined;
  let tenant: Tenant | undefined;
  const devicePublished = async (user: string, id: number) => {
    const { localpart, server } = splitId(user);
    if (!user.startsWith('@') || !localpart || server !== identity.server) {
      return false;
    }
    try {
      return await tenant?.tx((tx) =>
        tx.e2ee.coversDevicePublication(localpart, user, id)
      ) ?? false;
    } catch (error) {
      if (error instanceof MatrixError && error.status === 503) return false;
      throw error;
    }
  };
  let initializing: Promise<NodeIdentity> | undefined;
  let handleLink: ReturnType<typeof linkHandler> | undefined;
  let inbox: ReturnType<typeof startInboxWorker> | undefined;
  let mailbox: Mailbox | undefined;
  let authExports: ReturnType<typeof startAccountExports> | undefined;
  let keyExports: ReturnType<typeof startAccountExports> | undefined;
  let toDeviceExports: ReturnType<typeof startAccountExports> | undefined;
  let membershipExports: ReturnType<typeof startAccountExports> | undefined;
  let deactivation: ReturnType<typeof startDeactivationWork> | undefined;
  let profileFanout: ReturnType<typeof startProfileFanout> | undefined;
  let deviceLists: DeviceListService | undefined;
  let deviceEdus: EduState | undefined;
  let sender: Sender | undefined;
  let pushSender: Promise<PushSender> | undefined;
  let delayedEvents: DelayedEvents | undefined;
  let closed: Promise<void> | undefined;
  let refreshing = Promise.resolve();
  let roomExports: ReturnType<typeof startRoomExports> | undefined;
  let roomBinding: string | undefined;
  const releaseRoomExports = async () => {
    await roomExports?.close();
    roomExports = undefined;
    roomBinding = undefined;
  };
  const pairings = () => {
    if (!node) {
      throw new LinkError(
        'LINK_UNPAIRED',
        'facade node has not been initialized',
        503,
      );
    }
    return Promise.resolve(
      new Pairings(server, node.signer(), node.publicKey, pin, node),
    );
  };
  const keyOwner = async () => {
    const owner = await pairings();
    return new FacadeKeys(server, node!.signer(), node!.publicKey, owner);
  };
  // Contact time is operator diagnostics, never authority or a link ACK barrier.
  // Share the existing observation writer across all lightweight key owners.
  // Abrupt crashes may lose queued/uncommitted times; orderly close drains them.
  const contacts = new ContactObservations<number>(
    async (_key, latest) => await (await keyOwner()).contact(latest),
    Math.max,
    (error) => console.error('facade contact diagnostics:', error),
  );
  const roomOwner = async () =>
    new RoomReplicas(
      store,
      await pairings(),
      identity.server,
      productionKeyResolver(
        (await keyOwner()).verificationKeys(),
      ),
    );
  const ownerControls = async () =>
    new OwnerControls(
      server,
      await store.tenant(identity.server),
      await pairings(),
      node!,
    );
  const refreshBinding = async () => {
    if (closed) return;
    readiness.bindingChanged();
    notices.changed();
    inbox?.wake();
    if (!node) return;
    const owner = await pairings();
    let grant;
    try {
      grant = await owner.active();
    } catch (error) {
      if (error instanceof LinkError && error.code === 'LINK_UNPAIRED') {
        await releaseRoomExports();
        return;
      }
      throw error;
    }
    if (grant.body.transcript.body.context.url !== settings.url) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'facade URL does not match the accepted home binding',
        403,
      );
    }
    tenant = await enrolledTenant(
      store,
      owner,
      identity.server,
      identity.node,
      settings.phase === 'f2'
        ? new FacadeAuth(server, owner, node, authHealth, settings)
        : undefined,
    );
    if (caps.service('deactivation') && !deactivation) {
      deactivation = startDeactivationWork({
        store,
        tenant,
        pollseconds: settings.pollseconds,
        prepareSigner: async () => (await keyOwner()).prepareSigner(),
        wake: (destination) => {
          sender?.wake(destination);
          notices.changed();
        },
        failed: (error) =>
          workerFailure({
            owner: 'facade deactivation',
            server: identity.server,
            node: identity.node,
          }, error),
      });
    }
    if (settings.phase === 'f2' && !profileFanout) {
      profileFanout = startProfileFanout({
        store,
        tenant,
        pollseconds: settings.pollseconds,
        room: async (roomId) => {
          await new DirectoryReplicas(server, owner, identity.server)
            .requireScope('room:' + roomId);
          return await openRoom(store, roomId);
        },
        prepareSigner: async (work) => {
          await new DirectoryReplicas(server, await pairings(), identity.server)
            .requireScope('domain:@' + work.localpart + ':' + identity.server);
          return await (await keyOwner()).prepareSigner();
        },
        failed: (error) =>
          workerFailure({
            owner: 'facade profile fanout',
            server: identity.server,
            node: identity.node,
          }, error),
      });
    }
    if (settings.phase === 'f2' && !authExports) {
      authExports = startAccountExports({
        store,
        tenant,
        pollseconds: settings.pollseconds,
        users: async () =>
          (await (await store.tenant(identity.server)).query(
            'SELECT localpart FROM account_auth_snapshots ORDER BY localpart',
          )).map((row) => String(row.localpart)),
        emit: async (localpart) => {
          const owner = await pairings();
          await exportSessionAuthority(
            store,
            tenant!,
            owner,
            await ownerControls(),
            node!,
            localpart,
          );
          await new DomainOperations(store, tenant!, owner, node!).export(
            localpart,
          );
        },
        changed: () => notices.changed(),
        failed: (error) =>
          workerFailure({
            owner: 'facade auth export',
            server: identity.server,
            node: identity.node,
            peer: 'home',
          }, error),
      });
    }
    if (settings.phase === 'f2' && !keyExports) {
      keyExports = startAccountExports({
        store,
        tenant,
        pollseconds: settings.pollseconds,
        users: async () =>
          (await (await store.tenant(identity.server)).query(
            'SELECT localpart FROM account_auth_snapshots ORDER BY localpart',
          )).map((row) => String(row.localpart)),
        emit: async (localpart) =>
          await new DeviceOperations(store, tenant!, await pairings(), node!)
            .exportChanges(localpart),
        changed: () => notices.changed(),
        failed: (error) =>
          workerFailure({
            owner: 'facade key export',
            server: identity.server,
            node: identity.node,
            peer: 'home',
          }, error),
      });
    }
    if (settings.phase === 'f2' && !toDeviceExports) {
      toDeviceExports = startAccountExports({
        store,
        tenant,
        pollseconds: settings.pollseconds,
        users: async () =>
          (await (await store.tenant(identity.server)).query(
            'SELECT localpart FROM account_auth_snapshots ORDER BY localpart',
          )).map((row) => String(row.localpart)),
        emit: async (localpart) =>
          await new ToDeviceOperations(store, tenant!, await pairings(), node!)
            .export(localpart),
        changed: () => notices.changed(),
        failed: (error) =>
          workerFailure({
            owner: 'facade to-device export',
            server: identity.server,
            node: identity.node,
            peer: 'home',
          }, error),
      });
    }
    if (settings.phase === 'f2' && !membershipExports) {
      membershipExports = startMembershipExports({
        store,
        server,
        tenant,
        pollseconds: settings.pollseconds,
        users: async () =>
          (await (await store.tenant(identity.server)).query(
            'SELECT localpart FROM account_auth_snapshots ORDER BY localpart',
          )).map((row) => String(row.localpart)),
        emit: async (localpart) =>
          await new MembershipOperations(
            store,
            tenant!,
            await pairings(),
            node!,
          )
            .export(localpart),
        changed: () => notices.changed(),
        failed: (error) =>
          console.error(
            'facade membership export:',
            error instanceof LinkError ? error.code : 'LINK_UNAVAILABLE',
          ),
      });
    }
    if (settings.phase === 'f2') {
      const binding = grant.body.transcript.body.context.id;
      if (roomBinding !== binding) {
        await releaseRoomExports();
        roomExports = startRoomExports({
          store,
          self: identity.server,
          peer: 'home',
          pairing: binding,
          version: 2,
          changed: () => notices.changed(),
          failed: (error) =>
            workerFailure({
              owner: 'facade room export',
              server: identity.server,
              node: identity.node,
              peer: 'home',
            }, error),
        });
        roomBinding = binding;
      }
      roomExports?.wake();
    }
  };
  const refresh = () => {
    const run = refreshing.then(refreshBinding);
    refreshing = run.then(() => undefined, () => undefined);
    return run;
  };
  const acceptConfigured = async () => {
    // A file bootstraps a binding, not a second live registry. Restart never
    // requires its old plaintext secret; later re-enrollment uses local accept.
    if (
      node && settings.pairfile && (await pairingStatus(server)).length === 0
    ) {
      await (await pairings()).accept(
        JSON.parse(await readProtectedFile(settings.pairfile)),
      );
    }
  };
  try {
    if (binding.initialized) {
      node = await loadNode(server, identity.server, identity.node);
    }
    await acceptConfigured();
    await refresh();
  } catch (error) {
    await drainResources([() => mediaCache.close(), () => store.close()]);
    throw error;
  }
  if (caps.service('link-inbox')) {
    inbox = startInboxWorker({
      journal,
      peer: 'home',
      pollseconds: settings.pollseconds,
      apply: async (stream) =>
        stream.stream === 'control'
          ? await (await keyOwner()).apply(journal, stream)
          : stream.stream === 'owner-control'
          ? await (await ownerControls()).apply(journal, stream)
          : settings.phase === 'f2' && stream.stream.startsWith('auth:')
          ? await new AccountSnapshots(
            store,
            tenant!,
            await pairings(),
            await ownerControls(),
          ).apply(journal, stream)
          : settings.phase === 'f2' && stream.stream.startsWith('domain:')
          ? await new DomainOperations(store, tenant!, await pairings(), node!)
            .apply(journal, stream)
          : settings.phase === 'f2' && isKeyStream(stream)
          ? await new DeviceOperations(store, tenant!, await pairings(), node!)
            .apply(journal, stream)
          : settings.phase === 'f2' && isToDeviceStream(stream)
          ? await new ToDeviceOperations(
            store,
            tenant!,
            await pairings(),
            node!,
          )
            .apply(journal, stream)
          : settings.phase === 'f2' && stream.stream.startsWith('membership:')
          ? await new MembershipOperations(
            store,
            tenant!,
            await pairings(),
            node!,
          )
            .apply(
              journal,
              stream,
              productionKeyResolver(
                (await keyOwner()).verificationKeys(),
              ),
            )
          : stream.stream === 'directory'
          ? await new DirectoryReplicas(
            server,
            await pairings(),
            identity.server,
          ).apply(journal, stream)
          : stream.stream.startsWith('room:')
          ? await (await roomOwner()).apply(journal, stream)
          : stream.stream.startsWith('public:')
          ? await new PublicReplicas(store, tenant!, await pairings()).apply(
            journal,
            stream,
          )
          : stream.stream.startsWith('egress:')
          ? await new EgressOwner(
            server,
            await pairings(),
            async (envelope) =>
              dispatchBatch(
                server,
                await (await keyOwner()).requestSigner(),
                envelope,
              ),
            devicePublished,
          ).apply(journal, stream)
          : await apply(journal, stream),
      changed: (stream) => {
        readiness.applied(stream.incarnation, stream.stream);
        notices.changed();
      },
      failed: (error, stream, after) => {
        if (
          stream && after !== undefined && error instanceof LinkError &&
          ['LINK_BAD_RECORD', 'LINK_CAPABILITY_MISMATCH'].includes(error.code)
        ) {
          readiness.refused(stream.incarnation, stream.stream, after);
        }
        inboxFailure(
          {
            server: identity.server,
            node: identity.node,
            peer: 'home',
            initialized: !!node,
            tenantAvailable: !!tenant,
            phase: settings.phase,
          },
          error,
          stream,
          after,
        );
      },
    });
  }
  const releaseServices = async () => {
    await drainResources([
      async () => {
        const service = delayedEvents;
        delayedEvents = undefined;
        await service?.stop();
      },
      async () => {
        const pending = pushSender;
        pushSender = undefined;
        await (await pending)?.stop();
      },
      async () => {
        const service = sender;
        sender = undefined;
        await service?.stop();
      },
      async () => {
        const service = deviceLists;
        deviceLists = undefined;
        deviceEdus = undefined;
        await service?.stop();
      },
    ]);
  };
  return {
    store,
    server,
    journal,
    tls,
    notices,
    capabilities: caps,
    localMediaCache: caps.service('media') ? mediaCache : undefined,
    mediaEgress: mediaEgress.check,
    pairings,
    verificationKeys: async () => (await keyOwner()).verificationKeys(),
    requestSigner: async () => (await keyOwner()).requestSigner(),
    prepareSigner: async () => (await keyOwner()).prepareSigner(),
    releaseServices,
    async delayedEvents(granted: Tenant) {
      if (!caps.service('delayed')) return undefined;
      await (await pairings()).active();
      if (closed || !tenant) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'delayed service requires enrollment',
        );
      }
      return delayedEvents ??= new DelayedEvents({ store, tenant: granted }, {
        admitRoom: async (roomId) => {
          await new DirectoryReplicas(server, await pairings(), identity.server)
            .requireScope('room:' + roomId);
        },
      });
    },
    async pushSender() {
      if (!caps.service('push')) return undefined;
      if (closed || !tenant) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'push service requires enrollment',
        );
      }
      if (pushSender) return await pushSender;
      const granted = tenant;
      const starting = (async () => {
        const stopHistory = await startNotificationHistory(server);
        try {
          const service = await startPushSender({ store, tenant: granted });
          return {
            tick: () => service.tick(),
            stop: () => drainResources([() => service.stop(), stopHistory]),
          };
        } catch (error) {
          await drainResources([stopHistory], [error]);
          throw error;
        }
      })();
      pushSender = starting;
      try {
        return await starting;
      } catch (error) {
        if (pushSender === starting) pushSender = undefined;
        throw error;
      }
    },
    async sender() {
      if (!caps.service('federation-sender') || !config().federation.enabled) {
        return undefined;
      }
      const authority = await keyOwner();
      const signer = authority.requestSigner();
      const binding = await pairings();
      if (closed || !tenant) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'facade sender requires active enrollment',
        );
      }
      if (sender) return sender;
      const owner = new EgressOwner(
        server,
        binding,
        (envelope) => dispatchBatch(server, signer, envelope),
        devicePublished,
      );
      sender = startSender({
        store,
        signer,
        dispatch: (envelope) => owner.dispatchLocal(envelope),
        onDelivered: () => projectTenant(store, identity.server),
      });
      const performingSender = sender;
      const inviteDeps: InviteDeps = {
        store,
        server,
        signer,
        keys: productionKeyResolver(authority.verificationKeys()),
        self: identity.server,
        wake: (destination) => performingSender.wake(destination),
      };
      const intents = joinCleanupProvider(
        inviteDeps,
        inviteIntentProvider(inviteDeps),
      );
      performingSender.setIntentProvider(intents);
      void intents.review().then((rows) => {
        for (const row of rows) performingSender.wake(row.destination);
      }).catch((error) => console.error('intent startup scan:', error));
      return sender;
    },
    async deviceLists(edus: EduState) {
      if (!caps.service('device-lists')) return undefined;
      const signer = (await keyOwner()).requestSigner();
      if (closed) {
        throw new MatrixError(503, 'M_UNAVAILABLE', 'facade is closing');
      }
      if (deviceLists) {
        if (deviceEdus !== edus) {
          throw new Error(
            'facade device service already bound to another EDU state',
          );
        }
        return deviceLists;
      }
      const granted = tenant;
      if (!granted) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'device service requires enrollment',
        );
      }
      // No await after the binding check: one runtime owns one service and its
      // dispatcher, including recovery flights which must stop before the store.
      deviceLists = deviceListService(server, granted, edus, signer);
      deviceEdus = edus;
      deviceLists.start();
      return deviceLists;
    },
    async profileFanout(localpart?: string) {
      if (!profileFanout) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'profile fanout unavailable',
        );
      }
      return await profileFanout.drain(localpart);
    },
    async ingress(transaction: TransactionDeps) {
      if (mailbox) return mailbox;
      const owner = await pairings();
      await owner.active();
      const directory = new DirectoryReplicas(
        server,
        owner,
        identity.server,
        settings.phase as 'f1' | 'f2',
        readiness,
      );
      mailbox = new Mailbox(server, {
        self: identity.server,
        node: node!,
        pairings: owner,
        transaction,
        phase: settings.phase as 'f1' | 'f2',
        scopeState: (scope, signal) => directory.scopeState(scope, signal),
        acceptEdu: (origin, raw, phase, receivedMs) =>
          acceptIngressEdu(
            origin,
            identity.server,
            raw,
            transaction.edus,
            phase,
            async (origin, raw) => {
              if (!tenant) {
                throw new LinkError(
                  'LINK_UNAVAILABLE',
                  'to-device owner unavailable',
                  503,
                );
              }
              return await new ToDeviceOperations(store, tenant, owner, node!)
                .ingress(origin, raw);
            },
            receivedMs,
          ),
        changed: () => notices.changed(),
      });
      return mailbox;
    },
    async grantedTenant() {
      if (!node) return null;
      try {
        await (await pairings()).active();
        return tenant ?? null;
      } catch (error) {
        if (error instanceof LinkError && error.code === 'LINK_UNPAIRED') {
          return null;
        }
        throw error;
      }
    },
    async passwordLogin() {
      if (
        !tenant || settings.phase !== 'f2' || !settings.replicatecredentials
      ) return false;
      await (await pairings()).active();
      const rows = await (await store.tenant(identity.server)).query(
        'SELECT 1 FROM account_auth_snapshots a JOIN credentials c ON c.localpart=a.localpart JOIN users u ON u.localpart=a.localpart WHERE a.credentials=1 AND u.deactivated=0 LIMIT 1',
      );
      return rows.length !== 0;
    },
    async requireReadScope(scope: string, allowAbsent?: boolean) {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
      ).requireReadScope(scope, allowAbsent);
    },
    async rankedDirectoryPage(
      offset: number,
      limit: number,
      signal?: AbortSignal,
    ) {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
        settings.phase as 'f1' | 'f2',
        readiness,
      ).rankedDirectoryPage(offset, limit, signal);
    },
    async prepareReadRoomScope(roomId: string, allowAbsent?: boolean) {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
      ).prepareReadRoomScope(roomId, allowAbsent);
    },
    async withCurrentScopes<T>(
      read: (requireScope: (scope: string) => Promise<void>) => Promise<T>,
      signal: AbortSignal,
    ): Promise<T> {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
        settings.phase as 'f1' | 'f2',
        readiness,
      ).withCurrentScopes(read, signal);
    },
    async requireScope(
      scope: string,
      allowAbsent?: boolean,
      signal?: AbortSignal,
    ) {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
        settings.phase as 'f1' | 'f2',
        readiness,
      ).requireScope(scope, allowAbsent, signal);
    },
    async prepareRoomScope(
      roomId: string,
      allowAbsent?: boolean,
      localUser?: string,
      signal?: AbortSignal,
    ) {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
        settings.phase as 'f1' | 'f2',
        readiness,
      ).prepareRoomScope(roomId, allowAbsent, localUser, signal);
    },
    async publicRooms() {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
      ).appliedPublicRooms();
    },
    async initialize() {
      const pending = initializing ??= initializeNode(
        server,
        identity.server,
        identity.node,
      );
      let initialized: NodeIdentity;
      try {
        initialized = await pending;
      } finally {
        if (initializing === pending) initializing = undefined;
      }
      node = initialized;
      await acceptConfigured();
      await refresh();
      return {
        server: node.server,
        node: node.node,
        incarnation: node.incarnation,
        keyId: node.keyId,
        publicKey: node.publicKey,
      };
    },
    progress: (scopes?: readonly string[]) =>
      replicationProgress(store, identity.server, 'facade', scopes),
    async status() {
      // Introspection reports one durable pairing cut, not a cached enrollment
      // flag followed by another active-authority lookup racing revocation.
      const bindings = await pairingStatus(server);
      const active = node
        ? bindings.find((binding) => binding.state === 'paired')
        : undefined;
      return {
        role: caps.role,
        server: identity.server,
        node: identity.node,
        initialized: !!node,
        enrolled: !!active,
        incarnation: node?.incarnation ?? null,
        keyId: node?.keyId ?? null,
        matrix: false,
        capacity: {
          ...await store.capacityStatus(),
          coldStartReclamation: 'after-identity-and-cache-index' as const,
        },
        scopes: active ? await (await roomOwner()).scopes(active.id) : [],
        streams: active ? await journal.streams('home', 'in') : [],
        keyRoster: active
          ? await (await keyOwner()).status()
          : { ready: false, revision: 0, lastHome: null },
        pairings: bindings,
      };
    },
    async authorize(peerPin: string, address: string | undefined) {
      if (
        !node || address === undefined ||
        !await (await pairings()).allowsHome(peerPin)
      ) {
        return false;
      }
      await mediaEgress.observe(address);
      return true;
    },
    async handle(request: Request, peerPin: string): Promise<Response> {
      if (!node) {
        throw new LinkError(
          'LINK_UNPAIRED',
          'facade node has not been initialized',
          503,
        );
      }
      // Challenges belong to this runtime lifetime, not one HTTP request.
      handleLink ??= linkHandler({
        server: identity.server,
        node: node.node,
        incarnation: node.incarnation,
        pairings,
        journal,
        limits: {
          maxItems: settings.batchmaxitems,
          maxBytes: settings.batchmaxbytes,
        },
        notices,
        changed: refresh,
        received: () => {
          notices.changed();
          inbox?.wake();
        },
        reconciled: (pairing) => authHealth.reconciled(pairing),
        contacted: () => contacts.observe(server.path, Date.now()),
        reconciling: () => authHealth.reconciliation(),
        connected: (pairing, signal) => authHealth.connected(pairing, signal),
        signKeyDocument: async (raw) => await (await keyOwner()).cosign(raw),
        activity: settings.phase === 'f2'
          ? {
            capture: async (pairing, relayPresence) => {
              if (!tenant) {
                throw new LinkError(
                  'LINK_UNAVAILABLE',
                  'live tenant unavailable',
                  503,
                );
              }
              return await new ActivityExchange(
                store,
                tenant,
                await pairings(),
                node,
              ).capture(pairing, relayPresence);
            },
            apply: async (pairing, snapshot, elapsed) => {
              if (!tenant) {
                throw new LinkError(
                  'LINK_UNAVAILABLE',
                  'live tenant unavailable',
                  503,
                );
              }
              await new ActivityExchange(store, tenant, await pairings(), node)
                .apply(pairing, snapshot, elapsed);
            },
          }
          : undefined,
      });
      return await handleLink(request, peerPin);
    },
    changed: refresh,
    keyDocument: async () => await (await keyOwner()).document(),
    close: () =>
      closed ??= (async () => {
        readiness.close();
        await refreshing;
        await releaseRoomExports();
        await authExports?.close();
        await keyExports?.close();
        await toDeviceExports?.close();
        await membershipExports?.close();
        await inbox?.close();
        await deactivation?.close();
        await profileFanout?.close();
        await releaseServices();
        await drainResources([
          () => contacts.close(),
          () => mediaCache.close(),
          () => store.close(),
        ]);
      })(),
  };
}
