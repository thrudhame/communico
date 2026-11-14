// Home-only connection manager. Pairing registry owns peers, configuration only
// selects node IDs. A stalled peer never serializes another peer's enrollment.
import type { App } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { capabilities } from './capabilities.ts';
import { openJournalClient } from './client.ts';
import { certificatePin, readProtectedFile } from './identity.ts';
import { Journal } from './journal.ts';
import { enrollLink } from './link.ts';
import { Pairings } from './pairing.ts';
import {
  LINK_CAPABILITIES,
  LinkError,
  object,
  type Stream,
  text,
} from './protocol.ts';
import { loadLinkTls } from './transport.ts';
import { startHomeLinkWorker } from './worker.ts';

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
  if (!settings.nodes.length) return { close: () => Promise.resolve() };
  const tls = await loadLinkTls(settings);
  const pairings = new Pairings(
    app.server,
    app.tenant.signer(),
    app.tenant.publicB64,
    certificatePin(tls.cert),
  );
  const journal = new Journal(app.server, LINK_CAPABILITIES);
  const controller = new AbortController();
  const workers = new Map<string, ReturnType<typeof startHomeLinkWorker>>();
  const jobs = new Map<string, Promise<void>>();
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
    if (peer.state === 'paired' && workers.has(id)) return;
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
    const client = await openJournalClient(pairings, id, tls);
    if (controller.signal.aborted) return;
    workers.set(
      id,
      startHomeLinkWorker({
        client,
        journal,
        limits: {
          maxItems: settings.batchmaxitems,
          maxBytes: settings.batchmaxbytes,
        },
        // The configuration owner already validates this enum at load.
        notify: settings.notify as 'websocket' | 'sse' | 'poll',
        pollseconds: settings.pollseconds,
        reconnectmaxseconds: settings.reconnectmaxseconds,
        apply: (stream) => apply(node, stream),
        failed: (error) => failed(node, error),
      }),
    );
  }
  let scanning: Promise<void> | undefined;
  const scan = () =>
    scanning ??= (async () => {
      try {
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
    close() {
      return closed ??= (async () => {
        clearInterval(timer);
        controller.abort();
        await scanning;
        await Promise.all(
          [...workers.values()].map((worker) => worker.close()),
        );
        await Promise.all(jobs.values());
      })();
    },
  };
}
