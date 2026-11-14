// A retained semantic pack supplies ordinary recovery reads, never local state
// or verdicts. The remote ingest verifies every returned PDU/snapshot as usual.
import { MatrixError } from '#engine/matrix-error.ts';
import type { Pdu } from '#engine/pdu.ts';
import type { Fetcher } from './deps.ts';
import type { ReplicaRoom } from './replica-export.ts';

export function recoveryPack(
  raw: unknown,
  roomId: string,
  fallback: Fetcher,
): Fetcher {
  const bad = (): never => {
    throw new MatrixError(
      400,
      'M_BAD_JSON',
      'invalid retained room recovery pack',
    );
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) bad();
  const manifest = raw as ReplicaRoom;
  if (
    manifest.version !== 1 || manifest.roomId !== roomId ||
    typeof manifest.roomVersion !== 'string' ||
    !Array.isArray(manifest.events) ||
    !Array.isArray(manifest.boundaries)
  ) bad();
  const pack = new Map<string, Pdu>();
  for (const event of manifest.events) {
    if (
      !event || typeof event !== 'object' ||
      typeof event.event_id !== 'string' ||
      (event.room_id !== undefined && event.room_id !== roomId) ||
      pack.has(event.event_id)
    ) bad();
    pack.set(event.event_id!, event);
  }
  const boundaries = new Map(manifest.boundaries.map((boundary) => {
    if (
      !boundary || typeof boundary.eventId !== 'string' ||
      !Array.isArray(boundary.state) || !Array.isArray(boundary.authChain) ||
      [...boundary.state, ...boundary.authChain].some((id) =>
        typeof id !== 'string' || !pack.has(id)
      )
    ) bad();
    return [boundary.eventId, boundary] as const;
  }));
  if (boundaries.size !== manifest.boundaries.length) bad();
  const event = (id: string) => pack.get(id) ?? bad();
  return {
    ...fallback,
    event: (id, via, room, signal) =>
      room === roomId && pack.has(id)
        ? Promise.resolve(event(id))
        : fallback.event(id, via, room, signal),
    stateIds: (room, id, via, signal) => {
      const boundary = room === roomId ? boundaries.get(id) : undefined;
      return boundary
        ? Promise.resolve({
          pduIds: boundary.state,
          authChainIds: boundary.authChain,
        })
        : fallback.stateIds(room, id, via, signal);
    },
    state: (room, id, via, signal) => {
      const boundary = room === roomId ? boundaries.get(id) : undefined;
      return boundary
        ? Promise.resolve({
          state: boundary.state.map(event),
          authChain: boundary.authChain.map(event),
        })
        : fallback.state(room, id, via, signal);
    },
    eventAuth: (room, id, via) => {
      if (room !== roomId || !pack.has(id)) {
        return fallback.eventAuth(room, id, via);
      }
      const queue = [...(event(id).auth_events ?? [])],
        seen = new Set<string>();
      for (let index = 0; index < queue.length; index++) {
        const key = queue[index];
        if (seen.has(key)) continue;
        if (!pack.has(key)) return fallback.eventAuth(room, id, via);
        seen.add(key);
        queue.push(...(event(key).auth_events ?? []));
      }
      return Promise.resolve([...seen].map(event));
    },
    missingEvents: (room, earliest, latest, limit, via) => {
      if (room !== roomId || latest.some((id) => !pack.has(id))) {
        return fallback.missingEvents(room, earliest, latest, limit, via);
      }
      const seen = new Set(earliest),
        queue = latest.flatMap((id) => event(id).prev_events ?? []);
      const result: Pdu[] = [];
      for (let index = 0; index < queue.length; index++) {
        const id = queue[index];
        if (seen.has(id)) continue;
        seen.add(id);
        if (!pack.has(id)) {
          return fallback.missingEvents(room, earliest, latest, limit, via);
        }
        result.push(event(id));
        queue.push(...(event(id).prev_events ?? []));
      }
      return Promise.resolve(result.reverse().slice(0, limit));
    },
  };
}
