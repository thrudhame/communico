// Operator delivery review composes each owner's truth, never manufactures an
// in-flight transaction or exposes already-settled PDU rows as queued work.
import type { App } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { listRejectIntents, pruneRejectIntents } from './invites.ts';
import {
  listOutbox,
  listPeerStatus,
  pruneDestination,
  retryDestination,
} from './sender.ts';

export async function reviewOutbox(app: App, destination: string | null) {
  const active = app.sender === null ? [] : app.sender.snapshot();
  const rows = (await listOutbox(
    app.server,
    destination === null ? undefined : destination,
  ))
    .filter((row) => row.state === 'pending').map((row) => {
      const flight = active.find((a) =>
        a.destination === row.destination &&
        a.rows.includes(`${row.room}:${row.pos}`)
      );
      return {
        id: `${row.room}:${row.pos}`,
        destination: row.destination,
        kind: 'pdu' as const,
        eventId: row.event,
        intent: null,
        addedMs: row.addedMs,
        expiresMs: row.addedMs + config().federation.refusedmillihours * 3600,
        inflightTxn: flight === undefined ? null : flight.txnId,
      };
    });
  const live = app.sender === null ? null : await app.sender.reviewIntents();
  const intents = live === null
    ? await listRejectIntents(app.server, app.tenant.serverName)
    : live;
  return {
    rows: [
      ...rows,
      ...intents.filter((r) =>
        destination === null || r.destination === destination
      ),
    ],
    statuses: await listPeerStatus(app.server),
  };
}

export async function retryOutbox(app: App, destination: string) {
  await retryDestination(app.server, destination);
  app.sender?.wake(destination);
}

export async function pruneOutbox(
  app: App,
  destination: string,
): Promise<number> {
  const pdu = await pruneDestination(app.server, destination);
  const live = app.sender === null
    ? null
    : await app.sender.pruneIntents(destination);
  return pdu +
    (live === null
      ? await pruneRejectIntents(app.server, app.tenant.serverName, destination)
      : live);
}
