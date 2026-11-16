// Independent node composition: no application singleton, home tenant genesis,
// public Matrix listener, or home-only worker is needed for local enrollment.
import { config, serverName } from '#engine/config.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { productionKeyResolver } from '#engine/federation/keyresolver.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type StoreConfig } from '#engine/store/index.ts';
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
import { NoticeHub } from './notices.ts';
import { Pairings, pairingStatus } from './pairing.ts';
import { RoomReplicas } from './replication.ts';
import { PublicReplicas } from './public.ts';
import { DirectoryReplicas } from './directory.ts';
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
import { dispatchBatch } from '#engine/federation/sender.ts';
import {
  AccountSnapshots,
  exportSessionAuthority,
  startAccountExports,
} from './accounts.ts';
import { AuthLinkHealth, FacadeAuth } from './auth.ts';
import { startDeactivationWork } from '#engine/deactivation.ts';

export async function openFacadeRuntime(
  storeConfig: StoreConfig = config().store,
  apply: (journal: Journal, stream: Stream) => Promise<boolean> = () =>
    Promise.resolve(false),
) {
  const settings = config().facade;
  const caps = capabilities(config().server.role, settings.phase);
  const authHealth = new AuthLinkHealth(settings);
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
  const store = await openStore(storeConfig, {
    schemas: { server: serverSchema, tenant: tenantSchema, room: roomSchema },
    beforeStartup: (store) => bindRole(store, identity),
  });
  const server = await store.server();
  const journal = new Journal(server, LINK_SUPPORTED);
  const notices = new NoticeHub();
  let node: NodeIdentity | undefined;
  let tenant: Tenant | undefined;
  let initializing: Promise<NodeIdentity> | undefined;
  let inbox: ReturnType<typeof startInboxWorker> | undefined;
  let mailbox: Mailbox | undefined;
  let authExports: ReturnType<typeof startAccountExports> | undefined;
  let deactivation: ReturnType<typeof startDeactivationWork> | undefined;
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
  const roomOwner = async () =>
    new RoomReplicas(
      store,
      await pairings(),
      identity.server,
      productionKeyResolver(
        server,
        node!.signer(),
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
  const refresh = async () => {
    notices.changed();
    inbox?.wake();
    if (!node) return;
    const owner = await pairings();
    let grant;
    try {
      grant = await owner.active();
    } catch (error) {
      if (error instanceof LinkError && error.code === 'LINK_UNPAIRED') {
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
        // OOB rejection is durable at its existing intent owner. B7 composes
        // the performing sender; link observers are woken without a home RPC.
        wake: () => notices.changed(),
        failed: (error) =>
          console.error(
            'facade deactivation pending:',
            error instanceof LinkError ? error.code : 'M_UNAVAILABLE',
          ),
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
        emit: async (localpart) =>
          exportSessionAuthority(
            store,
            tenant!,
            await pairings(),
            await ownerControls(),
            node!,
            localpart,
          ),
        changed: () => notices.changed(),
        failed: (error) =>
          console.error(
            'facade auth export:',
            error instanceof LinkError ? error.code : 'LINK_UNAVAILABLE',
          ),
      });
    }
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
    const binding = await bindRole(store, identity);
    if (binding.initialized) {
      node = await loadNode(server, identity.server, identity.node);
    }
    await acceptConfigured();
    await refresh();
  } catch (error) {
    await store.close();
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
          ).apply(journal, stream)
          : await apply(journal, stream),
      changed: () => notices.changed(),
      failed: (error) =>
        console.error(
          'facade inbox:',
          error instanceof LinkError ? error.code : 'LINK_UNAVAILABLE',
        ),
    });
  }
  let closed: Promise<void> | undefined;
  return {
    store,
    server,
    journal,
    tls,
    notices,
    capabilities: caps,
    pairings,
    verificationKeys: async () => (await keyOwner()).verificationKeys(),
    requestSigner: async () => (await keyOwner()).requestSigner(),
    prepareSigner: async () => (await keyOwner()).prepareSigner(),
    async ingress(transaction: TransactionDeps) {
      if (mailbox) return mailbox;
      const owner = await pairings();
      await owner.active();
      const directory = new DirectoryReplicas(server, owner, identity.server);
      mailbox = new Mailbox(server, {
        self: identity.server,
        node: node!,
        pairings: owner,
        transaction,
        scopeState: (scope) => directory.scopeState(scope),
        acceptEdu: (origin, raw) =>
          acceptIngressEdu(origin, identity.server, raw, transaction.edus),
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
    async requireScope(scope: string, allowAbsent?: boolean) {
      return await new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
      ).requireScope(scope, allowAbsent);
    },
    async publicRooms() {
      const owner = new DirectoryReplicas(
        server,
        await pairings(),
        identity.server,
      );
      const view = await owner.snapshot();
      if (!view) {
        throw new MatrixError(
          503,
          'M_UNAVAILABLE',
          'directory replica not ready',
        );
      }
      return view.publicRooms;
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
        scopes: active ? await (await roomOwner()).scopes(active.id) : [],
        streams: active ? await journal.streams('home', 'in') : [],
        keyRoster: active
          ? await (await keyOwner()).status()
          : { ready: false, revision: 0, lastHome: null },
        pairings: bindings,
      };
    },
    authorize: async (peerPin: string) =>
      node ? await (await pairings()).allowsHome(peerPin) : false,
    async handle(request: Request, peerPin: string): Promise<Response> {
      if (!node) {
        throw new LinkError(
          'LINK_UNPAIRED',
          'facade node has not been initialized',
          503,
        );
      }
      return await linkHandler({
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
        contacted: async () => await (await keyOwner()).contact(),
        reconciling: () => authHealth.reconciliation(),
        connected: (pairing, signal) => authHealth.connected(pairing, signal),
        signKeyDocument: async (raw) => await (await keyOwner()).cosign(raw),
      })(request, peerPin);
    },
    changed: refresh,
    keyDocument: async () => await (await keyOwner()).document(),
    close: () =>
      closed ??= (async () => {
        await authExports?.close();
        await inbox?.close();
        await deactivation?.close();
        await store.close();
      })(),
  };
}
