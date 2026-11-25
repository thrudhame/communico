// Transient observations from authenticated federation, relayed only by the
// home-initiated activity exchange. Not a delivery queue or a visibility grant.
import { config } from '#engine/config.ts';
import {
  REMOTE_PRESENCE_FRESHNESS_MS,
  type RemotePresenceObservation,
} from '#engine/server/ephemeral.ts';
import type { Database } from '#engine/store/db.ts';

type Entry = { value: RemotePresenceObservation; bytes: number };
type Inbox = { observations: Map<string, Entry>; bytes: number };
const inboxes = new WeakMap<Database, Inbox>();

function forget(inbox: Inbox, user: string): void {
  inbox.bytes -= inbox.observations.get(user)?.bytes ?? 0;
  inbox.observations.delete(user);
}

export function receiveRemotePresence(
  server: Database,
  value: RemotePresenceObservation,
): void {
  const { batchmaxbytes, batchmaxitems } = config().facade;
  const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
  if (bytes > batchmaxbytes) return;
  let inbox = inboxes.get(server);
  if (!inbox) {
    inboxes.set(server, inbox = { observations: new Map(), bytes: 0 });
  }
  const prior = inbox.observations.get(value.userId);
  if (prior && prior.value.receivedMs > value.receivedMs) return;
  forget(inbox, value.userId);
  inbox.observations.set(value.userId, { value, bytes });
  inbox.bytes += bytes;
  while (
    inbox.observations.size > batchmaxitems || inbox.bytes > batchmaxbytes
  ) {
    forget(inbox, inbox.observations.keys().next().value!);
  }
}

export function captureRemotePresence(
  server: Database,
): RemotePresenceObservation[] {
  const inbox = inboxes.get(server);
  if (!inbox) return [];
  const now = Date.now();
  for (const [user, { value }] of inbox.observations) {
    if (now - value.receivedMs >= REMOTE_PRESENCE_FRESHNESS_MS) {
      forget(inbox, user);
    }
  }
  return [...inbox.observations.values()].map(({ value }) => value);
}
