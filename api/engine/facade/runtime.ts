// Independent node composition: no application singleton, home tenant genesis,
// public Matrix listener, or home-only worker is needed for local enrollment.
import { config, serverName } from '#engine/config.ts';
import { roomSchema } from '#engine/room/index.ts';
import { serverSchema } from '#engine/server/schema.ts';
import { openStore, type StoreConfig } from '#engine/store/index.ts';
import { tenantSchema } from '#engine/tenant/index.ts';
import { capabilities } from './capabilities.ts';
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
import { LINK_CAPABILITIES, LinkError } from './protocol.ts';
import { bindRole } from './role.ts';
import { loadLinkTls } from './transport.ts';
import { startInboxWorker } from './worker.ts';
import type { Stream } from './protocol.ts';

export async function openFacadeRuntime(
  storeConfig: StoreConfig = config().store,
  apply: (journal: Journal, stream: Stream) => Promise<boolean> = () =>
    Promise.resolve(false),
) {
  const settings = config().facade;
  const caps = capabilities(config().server.role);
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
  const journal = new Journal(server, LINK_CAPABILITIES);
  const notices = new NoticeHub();
  let node: NodeIdentity | undefined;
  let paired = false;
  let initializing: Promise<NodeIdentity> | undefined;
  let inbox: ReturnType<typeof startInboxWorker> | undefined;
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
        paired = false;
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
    await enrolledTenant(store, owner, identity.server, identity.node);
    paired = true;
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
      apply: (stream) => apply(journal, stream),
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
      return {
        role: caps.role,
        server: identity.server,
        node: identity.node,
        initialized: !!node,
        enrolled: paired,
        incarnation: node?.incarnation ?? null,
        keyId: node?.keyId ?? null,
        matrix: false,
        scopes: [],
        pairings: await pairingStatus(server),
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
      })(request, peerPin);
    },
    changed: refresh,
    close: () =>
      closed ??= (async () => {
        await inbox?.close();
        await store.close();
      })(),
  };
}
