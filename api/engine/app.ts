// api/engine/app.ts — the composition root: one store, the configured
// server's tenant, and (when federation is enabled) the federation
// services, held for the endpoint tree. main.ts opens the app before
// serving; the HTTP tests open one per file on a fresh store. Endpoints
// reach the tenant through theApp() the way the old code reached the
// lazily-provisioned tenant database (doltgres:api/engine/tenant.ts's
// ensureTenant). installServerHooks rides openApp once per process —
// the room projection and the startup roll-forward are part of every
// app store (4b), engine tests keep opening schema-less stores without
// it.
import { config, serverName } from '#engine/config.ts';
import { assertRestoreReport } from '#engine/backup/report.ts';
import { bindRole } from '#engine/facade/role.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { DelayedEvents } from '#engine/delayed-events.ts';
import { drainResources } from '#engine/lifetime.ts';
import { MediaService } from '#engine/media/service.ts';
import { installRuleMigration } from '#engine/client/rule-migration.ts';
import {
  type EduQueues,
  eduQueues,
  type EduState,
  eduState,
} from '#engine/federation/edus.ts';
import { wireEphemeral } from '#engine/federation/ephemeral.ts';
import { registerToDevice } from '#engine/federation/todevice.ts';
import {
  type DeviceListService,
  deviceListService,
} from '#engine/federation/device-lists.ts';
import { projectTenant } from '#engine/server/project-tenant.ts';
import { startNotificationHistory } from '#engine/server/notification-history.ts';
import { type PushSender, startPushSender } from '#engine/push/sender.ts';
import {
  type InviteDeps,
  inviteIntentProvider,
} from '#engine/federation/invites.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { joinCleanupProvider } from '#engine/federation/join-cleanup.ts';
import {
  type KeyDoc,
  type KeyStore,
  keyStore,
} from '#engine/federation/keys.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks, recoverServer } from '#engine/server/startup.ts';
import type { Database as Db } from '#engine/store/db.ts';
import type { Signer } from '#engine/room/signer.ts';
import {
  openStore,
  type Store,
  type StoreConfig,
} from '#engine/store/index.ts';
import { openTenant, type Tenant, tenantSchema } from '#engine/tenant/index.ts';

export type App = {
  readonly store: Store;
  readonly server: Db;
  // The tenant of the configured server name (one server, one tenant).
  readonly tenant: Tenant;
  readonly federationKeys: KeyStore;
  readonly federationEdus: EduState;
  readonly deviceLists: DeviceListService;
  // The delivery worker — null until startFederationServices (federation
  // disabled, or an endpoint-test app).
  sender: Sender | null;
  readonly pushSender: PushSender;
  readonly media: MediaService;
  delayedEvents: DelayedEvents;
  readonly replica?: ReplicaAccess;
  close(): Promise<void>;
};

/** Granted read dependencies are supplied by the node composition root. The
 * endpoint tree never reconstructs a home identity or reaches into a link owner. */
export type ReplicaAccess = {
  requireScope(scope: string, allowAbsent?: boolean): Promise<void>;
  keyDocument(): Promise<KeyDoc>;
  publicRooms(): Promise<boolean>;
  keys: KeyStore;
  signer: Signer;
};

let hooksInstalled = false;
let current: App | null = null;

export function prepareAppRecovery(): void {
  if (hooksInstalled) return;
  hooksInstalled = true;
  installServerHooks();
}

/** The running app; throws before openApp (an endpoint without one is a
 * programming error, never a runtime state). */
export function theApp(): App {
  if (current === null) throw new Error('theApp: no app open');
  return current;
}

/** Open the store (all three schema providers) and the configured
 * server's tenant; install the server hooks once per process. One app
 * per process — a second openApp before closeApp throws. */
export async function openApp(storeConfig?: StoreConfig): Promise<App> {
  if (current !== null) throw new Error('openApp: an app is already open');
  // A facade must enter through explicit enrolled-node composition. Never let
  // selecting the role fall through to home identity genesis or home workers.
  if (config().server.role === 'facade') {
    throw new Error('facade requires enrolled node composition');
  }
  prepareAppRecovery();
  const store = await openStore(storeConfig ?? config().store, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
    beforeStartup: (store) =>
      bindRole(store, { role: 'home', server: serverName(), node: '' }),
  });
  const services: (() => void | Promise<void>)[] = [];
  const stopServices = () => drainResources(services.splice(0).reverse());
  try {
    await assertRestoreReport(store);
    const tenant = await openTenant(store, serverName(), { create: true });
    await tenant.tx((tx) => tx.slidingSync.prune());
    const server = await store.server();
    const media = new MediaService(server, tenant);
    services.push(() => media.close());
    const stopRuleMigration = await installRuleMigration(store, tenant);
    services.push(stopRuleMigration);
    const stopNotificationHistory = await startNotificationHistory(server);
    services.push(stopNotificationHistory);
    const federationEdus = eduState(server, tenant.serverName, store);
    const deviceLists = deviceListService(server, tenant, federationEdus);
    services.push(() => deviceLists.stop());
    const pushSender = await startPushSender({ store, tenant });
    services.push(() => pushSender.stop());
    const delayedEvents = new DelayedEvents({ store, tenant });
    services.push(() => delayedEvents.stop());
    const app: App = {
      store,
      server,
      tenant,
      federationKeys: keyStore(server, { signer: tenant.signer() }),
      federationEdus,
      deviceLists,
      sender: null,
      pushSender,
      media,
      delayedEvents,
      close: async () => {
        const sender = app.sender;
        app.sender = null;
        await drainResources([
          () => sender?.stop(),
          stopServices,
          () => store.close(),
        ]);
      },
    };
    registerToDevice(app.federationEdus, tenant);
    current = app;
    app.delayedEvents.wake();
    return app;
  } catch (error) {
    await drainResources([stopServices, () => store.close()], [error]);
    throw error;
  }
}

/** Bind already-enrolled tenant/store capabilities to the ordinary read tree.
 * No owner-only service is constructed. Asking for one refuses at this common
 * service boundary, even if a future adapter accidentally bypasses route gates.
 * The caller retains the node/link lifecycle; closeApp drains its store as usual.
 */
export async function openReplicaApp(
  store: Store,
  tenant: Tenant,
  replica: ReplicaAccess,
): Promise<App> {
  if (current !== null) {
    throw new Error('openReplicaApp: an app is already open');
  }
  if (config().server.role !== 'facade' || tenant.serverName !== serverName()) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'replica composition requires the granted facade tenant',
    );
  }
  const server = await store.server();
  // The node owner has provisioned this exact signer. Never manufacture or
  // automatically adopt a tenant identity at the public composition boundary.
  const [node] = await server.query(
    'SELECT server_name,key_id,public_key FROM facade_node WHERE singleton=1',
  );
  if (
    node?.server_name !== tenant.serverName || node.key_id !== tenant.keyId ||
    node.public_key !== tenant.publicB64
  ) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'replica signer does not match its node',
    );
  }
  prepareAppRecovery();
  await recoverServer(store);
  const unavailable = (name: string): never => {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      name + ' service unavailable at this ingress',
    );
  };
  const app: App = {
    store,
    server,
    tenant,
    federationKeys: replica.keys,
    federationEdus: eduState(server, tenant.serverName, store),
    sender: null,
    replica,
    get deviceLists() {
      return unavailable('device-lists');
    },
    get pushSender() {
      return unavailable('push');
    },
    get media() {
      return unavailable('media');
    },
    get delayedEvents() {
      return unavailable('delayed');
    },
    close: () => store.close(),
  };
  current = app;
  return app;
}

/** The federation services of doltgres:main.ts's startSender() block:
 * the per-destination delivery worker on the outbox, fed by the EDU
 * queues and the reject-invite intent provider. Endpoints (5b) are not
 * part of this — no federation routes exist yet. */
export function startFederationServices(app: App): void {
  if (app.replica) {
    throw new MatrixError(
      503,
      'M_UNAVAILABLE',
      'home federation producers unavailable at this ingress',
    );
  }
  app.deviceLists.start();
  const name = serverName();
  const signer = app.tenant.signer();
  let senderRef: Sender | null = null;
  const queues: EduQueues = eduQueues(
    (userId) => userId.endsWith(':' + name),
    (destination) => senderRef?.wake(destination),
  );
  const sender = startSender({
    store: app.store,
    signer,
    drainEdus: queues.drain,
    onDelivered: () => projectTenant(app.store, app.tenant.serverName),
  });
  senderRef = sender;
  const inviteDeps: InviteDeps = {
    store: app.store,
    server: app.server,
    signer,
    keys: productionKeyResolver(app.server, signer),
    self: name,
    wake: (destination) => sender.wake(destination),
  };
  const intents = joinCleanupProvider(
    inviteDeps,
    inviteIntentProvider(inviteDeps),
  );
  sender.setIntentProvider(intents);
  void intents.review().then((rows) => {
    for (const row of rows) sender.wake(row.destination);
  }).catch((error) => console.error('intent startup scan:', error));
  const unwire = wireEphemeral(app.server, name, queues);
  app.sender = {
    ...sender,
    stop: async () => {
      await drainResources([unwire, () => sender.stop()]);
    },
  };
}

/** Close the running app (sender stopped, store closed) and forget it. */
export async function closeApp(): Promise<void> {
  const app = current;
  current = null;
  if (app !== null) await app.close();
}
