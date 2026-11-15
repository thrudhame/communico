import type { Room } from '#engine/room/index.ts';
import { stableCausalOrder } from '#engine/room/order.ts';
import {
  type RelationRow,
  relationsForEvents,
  relationsOf,
} from '#engine/server/read.ts';
import { ignoredSenders } from './ignored.ts';
import { canSeeEvent, canSeeEventAt } from './visibility.ts';
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
  return (await relationBundlesFor(room, new Map([[eventId, parent]]), viewer, {
    threads: opts.threads,
    redacted: new Set(opts.redacted ? [eventId] : []),
  }, await ignoredSenders(viewer))).get(eventId)!;
}

/** Direct bundles have one server candidate capture and one room admission
 * attempt for every parent. Nested rendering remains the renderer's job. */
export async function relationBundlesFor(
  room: Room,
  parents: ReadonlyMap<string, Pdu>,
  viewer: Viewer,
  opts: { threads: boolean; redacted: ReadonlySet<string> },
  ignored: ReadonlySet<string>,
): Promise<Map<string, BundleSelection>> {
  const selected = new Map([...parents].filter(([, parent]) => {
    const relation = parent.content?.['m.relates_to'] as
      | { rel_type?: unknown }
      | null;
    return parent.state_key == null && relation?.rel_type !== 'm.replace' &&
      relation?.rel_type !== 'm.annotation';
  }));
  const candidates = await relationsForEvents(
    await room.store.server(),
    room.id,
    [...selected.keys()],
  );
  const result = new Map<string, BundleSelection>();
  for (const id of parents.keys()) {
    result.set(id, { references: [], replacement: null, thread: null });
  }
  if (!candidates.size) return result;
  return await room.tx(async (tx) => {
    const result = new Map<string, BundleSelection>();
    const rows = await tx.events.list([
      ...new Set(
        [...candidates.values()].flatMap((items) =>
          items.map((row) => row.eventId)
        ),
      ),
    ]);
    const visible = new Map<string, boolean>();
    for (const [id, row] of rows) {
      visible.set(
        id,
        !ignored.has(row.sender) && await canSeeEventAt(viewer.userId, tx, id),
      );
    }
    for (const [id, parent] of parents) {
      const bundle: BundleSelection = {
        references: [],
        replacement: null,
        thread: null,
      };
      result.set(id, bundle);
      const children = (candidates.get(id) ?? []).filter((row) =>
        visible.get(row.eventId)
      );
      const ordered = async (kind: string) => {
        const matching = new Map(
          children.filter((row) => row.relType === kind).map((
            row,
          ) => [row.eventId, row]),
        );
        const order = await stableCausalOrder(tx, [...matching.keys()]);
        return order.map((key) => matching.get(key)!);
      };
      bundle.references = (await ordered('m.reference')).map((row) =>
        row.eventId
      );
      if (!opts.redacted.has(id)) {
        let latest: { id: string; ts: number } | null = null;
        for (
          const child of children.filter((row) => row.relType === 'm.replace')
        ) {
          const row = rows.get(child.eventId)!;
          if (
            row.state_key !== null || row.sender !== parent.sender ||
            row.type !== parent.type
          ) continue;
          const replacement = (JSON.parse(row.pdu) as Pdu).content
            ?.['m.new_content'];
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
        bundle.replacement = latest?.id ?? null;
      }
      if (opts.threads) {
        const threads = await ordered('m.thread');
        if (threads.length) {
          bundle.thread = {
            latest: threads.at(-1)!.eventId,
            count: threads.length,
            participated: parent.sender === viewer.userId ||
              threads.some((row) =>
                rows.get(row.eventId)?.sender === viewer.userId
              ),
          };
        }
      }
    }
    return result;
  });
}

// Walk structurally valid edges first, then apply the viewer's presentation
// policy. An ignored/invisible intermediary cannot hide an otherwise visible
// descendant. Recursive expansion has an explicit traversal budget. Direct
// children are the result set itself, not an expanding graph: enumerate them
// completely, as required for reference bundles, without imposing that budget.
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
        if (opts.recurse && seen.size > 10_000) {
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
