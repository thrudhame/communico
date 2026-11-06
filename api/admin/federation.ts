// Each handler validates input and calls its engine owner; no storage logic here.
import type { App } from '#engine/app.ts';
import {
  addBlock,
  addPeer,
  listBlocks,
  listPeers,
  listPending,
  removeBlock,
  removePeer,
} from '#engine/federation/peers.ts';
import { approvePending, rejectPending } from '#engine/federation/gate.ts';
import {
  pruneOutbox,
  retryOutbox,
  reviewOutbox,
} from '#engine/federation/operator.ts';
import {
  AdminError,
  type Body,
  flag,
  type Operation,
  optionalText,
  text,
} from '#root/api/admin/protocol.ts';

function address(body: Body) {
  const host = optionalText(body, 'host');
  const port = body.port === undefined || body.port === null ? null : body.port;
  if (
    port !== null &&
    (typeof port !== 'number' || !Number.isInteger(port))
  ) {
    throw new AdminError('BAD_REQUEST', 'port must be an integer');
  }
  return { host, port: port as number | null };
}

export function federationOperations(app: App): Record<string, Operation> {
  const db = app.server;
  return {
    '/v1/federation-block/add': (b) =>
      addBlock(db, text(b, 'pattern'), optionalText(b, 'note')),
    '/v1/federation-block/remove': (b) => removeBlock(db, text(b, 'pattern')),
    '/v1/federation-block/list': () => listBlocks(db),
    '/v1/federation-peer/add': (b) => {
      const trust = text(b, 'trust');
      if (trust !== 'ca' && trust !== 'pinned' && trust !== 'keyname') {
        throw new AdminError('BAD_REQUEST', 'invalid trust');
      }
      return addPeer(db, {
        name: text(b, 'name'),
        ...address(b),
        trust,
        pin: optionalText(b, 'pin'),
        note: optionalText(b, 'note'),
        addedBy: 'operator',
      });
    },
    '/v1/federation-peer/remove': (b) => removePeer(db, text(b, 'name')),
    '/v1/federation-peer/list': () => listPeers(db),
    '/v1/federation-peer/pending': () => listPending(db),
    '/v1/federation-peer/approve': (b) => {
      const { host, port } = address(b);
      return approvePending(db, text(b, 'name'), host, port);
    },
    '/v1/federation-peer/reject': (b) =>
      rejectPending(db, text(b, 'name'), flag(b, 'block')),
    '/v1/federation-key/list': async (b) => {
      const name = optionalText(b, 'name');
      return {
        servers: await app.federationKeys.listServerKeys(name),
        changes: name === null
          ? []
          : await app.federationKeys.listKeyChanges(name),
      };
    },
    '/v1/federation-key/forget': (b) =>
      app.federationKeys.forgetServerKeys(text(b, 'name')),
    '/v1/federation-key/accept': (b) =>
      app.federationKeys.acceptKeyChange(text(b, 'name')),
    '/v1/federation-outbox/list': (b) =>
      reviewOutbox(app, optionalText(b, 'destination')),
    '/v1/federation-outbox/retry': (b) =>
      retryOutbox(app, text(b, 'destination')),
    '/v1/federation-outbox/prune': (b) =>
      pruneOutbox(app, text(b, 'destination')),
  };
}
