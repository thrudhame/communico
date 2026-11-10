import type { Room } from '#engine/room/index.ts';
import { stableCausalOrder } from '#engine/room/order.ts';
import { type RelationRow, relationsOf } from '#engine/server/read.ts';
import { ignoredSenders } from './ignored.ts';
import { canSeeEvent } from './visibility.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Viewer } from './render.ts';

// Walk structurally valid edges first, then apply the viewer's presentation
// policy. An ignored/invisible intermediary cannot hide an otherwise visible
// descendant. The bound is explicit, never a silently complete truncated page.
export async function relationView(
  room: Room,
  root: string,
  viewer: Viewer,
  opts: { recurse?: boolean; relType?: string; eventType?: string } = {},
): Promise<RelationRow[]> {
  const seen = new Set([root]);
  let parents = [root];
  const candidates: RelationRow[] = [];
  const server = await room.store.server();
  for (let depth = 0; depth < (opts.recurse ? 3 : 1); depth++) {
    const next: string[] = [];
    for (const parent of parents) {
      for (const row of await relationsOf(server, room.id, parent)) {
        if (seen.has(row.eventId)) continue;
        seen.add(row.eventId);
        if (seen.size > 10_000) {
          throw new MatrixError(
            503,
            'M_UNKNOWN',
            'relation traversal exceeds bounded history read',
          );
        }
        candidates.push(row);
        next.push(row.eventId);
      }
    }
    parents = next;
  }
  const ignored = await ignoredSenders(viewer);
  const eligible: RelationRow[] = [];
  for (const row of candidates) {
    const event = await room.tx((tx) => tx.events.get(row.eventId));
    if (
      event === null || ignored.has(event.sender) ||
      (opts.relType !== undefined && opts.relType !== row.relType) ||
      (opts.eventType !== undefined && opts.eventType !== event.type) ||
      !await canSeeEvent(viewer.userId, room, row.eventId)
    ) continue;
    eligible.push(row);
  }
  const ordered = await room.tx((tx) =>
    stableCausalOrder(tx, eligible.map((r) => r.eventId))
  );
  const rows = new Map(eligible.map((r) => [r.eventId, r]));
  return ordered.map((id) => rows.get(id)!);
}
