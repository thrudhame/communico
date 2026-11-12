import type { Room } from '#engine/room/index.ts';
import { stableCausalOrder } from '#engine/room/order.ts';
import { type RelationRow, relationsOf } from '#engine/server/read.ts';
import { ignoredSenders } from './ignored.ts';
import { canSeeEvent } from './visibility.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import type { Viewer } from './render.ts';
import type { Pdu } from '#engine/pdu.ts';

type BundleSelection = {
  references: string[];
  replacement: string | null;
  thread: { latest: string; count: number; participated: boolean } | null;
};

/** Select all bundles through the same structural/viewer relation policy.
 * Nested latest replies get edits/references, never recursive thread bundles. */
export async function relationBundles(
  room: Room,
  eventId: string,
  parent: Pdu,
  viewer: Viewer,
  opts: { threads: boolean; redacted: boolean },
): Promise<BundleSelection> {
  const result: BundleSelection = {
    references: [],
    replacement: null,
    thread: null,
  };
  const relation = parent.content?.['m.relates_to'] as
    | { rel_type?: unknown }
    | null;
  if (
    parent.state_key != null || relation?.rel_type === 'm.replace' ||
    relation?.rel_type === 'm.annotation'
  ) return result;
  result.references =
    (await relationView(room, eventId, viewer, { relType: 'm.reference' })).map(
      (r) => r.eventId,
    );
  if (!opts.redacted) {
    let latest: { id: string; ts: number } | null = null;
    for (
      const child of await relationView(room, eventId, viewer, {
        relType: 'm.replace',
      })
    ) {
      const row = await room.tx((tx) => tx.events.get(child.eventId));
      if (
        row === null || row.state_key !== null ||
        row.sender !== parent.sender || row.type !== parent.type
      ) continue;
      const content = (JSON.parse(row.pdu) as Pdu).content;
      const replacement = content?.['m.new_content'];
      // Encrypted new content exists only inside the ciphertext, not the envelope.
      if (
        row.type !== 'm.room.encrypted' &&
        (replacement === null || typeof replacement !== 'object' ||
          Array.isArray(replacement))
      ) continue;
      if (
        latest === null || row.origin_ts > latest.ts ||
        (row.origin_ts === latest.ts && row.id > latest.id)
      ) latest = { id: row.id, ts: row.origin_ts };
    }
    result.replacement = latest?.id ?? null;
  }
  if (opts.threads) {
    const children = await relationView(room, eventId, viewer, {
      relType: 'm.thread',
    });
    if (children.length > 0) {
      let participated = parent.sender === viewer.userId;
      for (const child of children) {
        const row = await room.tx((tx) => tx.events.get(child.eventId));
        if (row?.sender === viewer.userId) participated = true;
      }
      result.thread = {
        latest: children.at(-1)!.eventId,
        count: children.length,
        participated,
      };
    }
  }
  return result;
}

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
      for (
        const row of await relationsOf(
          server,
          room.id,
          parent,
          opts.recurse ? undefined : opts.relType,
        )
      ) {
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
