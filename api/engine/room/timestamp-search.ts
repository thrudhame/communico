import { domainOf } from '#engine/ids.ts';
import { aclAllows, AclDenied } from './acl.ts';
import { roomVersionOf } from './build.ts';
import { fetchOrNull } from './deps.ts';
import { backfill, type BackfillDeps, bridgeForwardAnchor } from './history.ts';
import type { Room, RoomTx } from './index.ts';
import {
  findTimestamp,
  type TimestampHit,
  type TimestampQuery,
} from './timestamp.ts';
import { verify } from './verify.ts';

// Conservative gap relevance: timestamps may be skewed in either direction,
// including across stays. An unresolved boundary cannot be excluded by distance.
async function unresolved(tx: RoomTx): Promise<boolean> {
  for (const segment of await tx.segments.list()) {
    if (segment.kind !== 'stay') {
      if (segment.status !== 'complete') return true;
      if (segment.kind === 'anchor') {
        const last = await tx.segments.positionsPage(
          segment.id,
          Number.MAX_SAFE_INTEGER,
          'b',
          1,
        );
        if (
          last.length === 0 ||
          (await tx.segments.step({
              segment: segment.id,
              offset: last[0].offset,
            }, 'f')).kind === 'gap'
        ) return true;
      }
      continue;
    }
    const first = await tx.segments.positionsPage(
      segment.id,
      -Number.MAX_SAFE_INTEGER,
      'f',
      1,
    );
    if (
      first.length > 0 &&
      (await tx.segments.step(
          { segment: segment.id, offset: first[0].offset },
          'b',
        )).kind === 'frontier'
    ) return true;
  }
  return false;
}

export async function timestampPeers(
  tx: RoomTx,
  self: string,
): Promise<string[]> {
  const stay = await tx.segments.openStay() ?? await tx.segments.latestStay();
  if (stay === null) return [];
  const group = await tx.state.current(stay.id);
  if (group === null) return [];
  const state = await tx.state.groupMap(group);
  const ranks = new Map<string, [number, number]>();
  for (const [key, id] of state) {
    if (!key.startsWith('m.room.member\0')) continue;
    const event = await tx.events.get(id);
    if (
      event === null || JSON.parse(event.pdu).content?.membership !== 'join'
    ) continue;
    const server = domainOf(key.slice('m.room.member\0'.length));
    if (server === self || !await aclAllows(tx, server)) continue;
    const pos = await tx.segments.positionOf(id);
    const rank: [number, number] = [pos?.segment ?? 0, pos?.offset ?? 0];
    const old = ranks.get(server);
    if (
      old === undefined || rank[0] < old[0] ||
      (rank[0] === old[0] && rank[1] < old[1])
    ) ranks.set(server, rank);
  }
  return [...ranks].sort(([a, x], [b, y]) =>
    x[0] - y[0] || x[1] - y[1] || a.localeCompare(b)
  ).slice(0, 3).map(([s]) => s);
}

// Client orchestration only. The federation route calls findTimestamp directly,
// so empty peers cannot recurse. Remote claims acquire genuine first-owner
// history anchors through the same verification/auth/state importer as backfill.
export async function searchTimestamp(
  room: Room,
  query: TimestampQuery,
  visible: (tx: RoomTx, id: string) => Promise<boolean>,
  deps: BackfillDeps & { self: string },
): Promise<TimestampHit | null> {
  const snapshot = await room.tx(async (tx) => ({
    local: await findTimestamp(tx, query, (id) => visible(tx, id)),
    gap: await unresolved(tx),
    peers: await timestampPeers(tx, deps.self),
    version: await roomVersionOf(tx, (await tx.segments.latestStay())!.id),
  }));
  if (snapshot.local !== null && !snapshot.gap) return snapshot.local;
  const signal = deps.signal ?? AbortSignal.timeout(8000);
  let best = snapshot.local;
  for (const via of snapshot.peers) {
    if (signal.aborted) break;
    const claim = await fetchOrNull(
      () =>
        deps.fetcher.timestampToEvent(
          room.id,
          query.ts,
          query.dir,
          via,
          signal,
        ),
      signal,
    );
    if (
      claim === null || typeof claim.event_id !== 'string' ||
      !Number.isSafeInteger(claim.origin_server_ts)
    ) continue;
    const raw = await fetchOrNull(
      () => deps.fetcher.event(claim.event_id, via, room.id, signal),
      signal,
    );
    if (raw === null || signal.aborted) continue;
    let verified;
    try {
      verified = await verify(raw, snapshot.version, deps.keys, {
        roomId: room.id,
        exemptPrevAuthLimits: true,
      });
    } catch {
      continue;
    }
    const ts = verified.pdu.origin_server_ts;
    if (
      verified.eventId !== claim.event_id || ts !== claim.origin_server_ts ||
      (query.dir === 'f' ? ts < query.ts : ts > query.ts)
    ) continue;
    if (
      best !== null &&
      (query.dir === 'f'
        ? ts > best.origin_server_ts
        : ts < best.origin_server_ts)
    ) continue;
    if (!await room.tx((tx) => aclAllows(tx, via))) continue;
    const positioned = await room.tx((tx) =>
      tx.segments.positionOf(verified.eventId)
    );
    try {
      if (positioned === null) {
        await backfill(room, {
          from: [verified.eventId],
          limit: 1,
          via,
          anchor: verified.pdu,
        }, { ...deps, signal });
      }
      const anchor = await room.tx((tx) =>
        tx.segments.positionOf(verified.eventId)
      );
      // Shared history needs a genuinely later join, not an arbitrary owner
      // stay. Use pagination's bounded importer to prove that connection.
      if (
        anchor !== null &&
        !await room.tx((tx) => visible(tx, verified.eventId))
      ) {
        await bridgeForwardAnchor(room, anchor, [via], 100, {
          ...deps,
          signal,
        });
      }
    } catch (error) {
      if (signal.aborted) break;
      // Only unavailable/denied network evidence is a peer failure. Storage
      // errors must not be disguised as a local miss.
      if (error instanceof AclDenied) continue;
      throw error;
    }
    best = await room.tx((tx) =>
      findTimestamp(tx, query, (id) => visible(tx, id))
    );
  }
  // Membership/ACL/history may have changed during the unlocked network phase.
  return await room.tx((tx) =>
    findTimestamp(tx, query, (id) => visible(tx, id))
  );
}
