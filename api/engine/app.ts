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
import { type EduQueues, eduQueues } from '#engine/federation/edus.ts';
import {
  type InviteDeps,
  inviteIntentProvider,
} from '#engine/federation/invites.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { type Sender, startSender } from '#engine/federation/sender.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { installServerHooks } from '#engine/server/startup.ts';
import type { Database as Db } from '#engine/store/db.ts';
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
  // The delivery worker — null until startFederationServices (federation
  // disabled, or an endpoint-test app).
  sender: Sender | null;
  close(): Promise<void>;
};

let hooksInstalled = false;
let current: App | null = null;

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
  if (!hooksInstalled) {
    hooksInstalled = true;
    installServerHooks();
  }
  const store = await openStore(storeConfig ?? config().store, {
    schemas: { room: roomSchema, server: serverSchema, tenant: tenantSchema },
  });
  try {
    const tenant = await openTenant(store, serverName(), { create: true });
    const server = await store.server();
    const app: App = {
      store,
      server,
      tenant,
      sender: null,
      close: async () => {
        await app.sender?.stop();
        app.sender = null;
        await store.close();
      },
    };
    current = app;
    return app;
  } catch (error) {
    await store.close();
    throw error;
  }
}

/** The federation services of doltgres:main.ts's startSender() block:
 * the per-destination delivery worker on the outbox, fed by the EDU
 * queues and the reject-invite intent provider. Endpoints (5b) are not
 * part of this — no federation routes exist yet. */
export function startFederationServices(app: App): void {
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
  sender.setIntentProvider(inviteIntentProvider(inviteDeps));
  app.sender = sender;
}

/** Close the running app (sender stopped, store closed) and forget it. */
export async function closeApp(): Promise<void> {
  const app = current;
  current = null;
  if (app !== null) await app.close();
}
