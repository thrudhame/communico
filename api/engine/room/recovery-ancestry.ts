// One batch's advisory graph capture, using the same bounded, cut-checked room
// read pages as recovery evidence. No mutable missing result crosses room cuts.
import type { AncestryNode } from '#engine/room/events.ts';
import type { Room } from '#engine/room/index.ts';
import type { Pdu } from '#engine/pdu.ts';

type Source = 'pushed' | 'pulled';
type Supply = ReadonlyMap<string, { pdu: Pdu; source: Source }>;
export type RecoverySnapshot = {
  head: number;
  supplied: Set<string>;
  boundaries: Set<string>;
  terminal: Set<string>;
  nodes: Map<string, AncestryNode>;
};

export class RecoveryAncestry {
  private saved: RecoverySnapshot | null = null;

  constructor(private room: Room, private active: () => boolean) {}

  async snapshot(
    live: Supply,
    boundaries: ReadonlyMap<string, unknown>,
    terminal: ReadonlySet<string>,
  ): Promise<RecoverySnapshot | null> {
    while (this.active()) {
      const head = await this.room.tx((tx) => tx.changes.head());
      const saved = this.saved;
      if (
        saved?.head === head && saved.supplied.size === live.size &&
        [...live.keys()].every((id) => saved.supplied.has(id)) &&
        saved.boundaries.size === boundaries.size &&
        [...boundaries.keys()].every((id) => saved.boundaries.has(id)) &&
        saved.terminal.size === terminal.size &&
        [...terminal].every((id) => saved.terminal.has(id))
      ) return saved;
      const nodes = new Map<string, AncestryNode>();
      const queue = [...live].map(([id, item]) => ({
        id,
        source: item.source,
      }));
      const seen = new Set(
        queue.map(({ id, source }) => JSON.stringify([id, source])),
      );
      let stale = false;
      for (let start = 0; start < queue.length && this.active();) {
        const page = queue.slice(start, start + 32);
        start += page.length;
        const read = await this.room.tx(async (tx) => {
          if (await tx.changes.head() !== head) return null;
          return await tx.events.ancestry([
            ...new Set(page.map((item) => item.id)),
          ]);
        });
        if (read === null) {
          stale = true;
          break;
        }
        for (const { id, source } of page) {
          const node = read.get(id);
          if (node !== undefined) nodes.set(id, node);
          if (node?.grounded || boundaries.has(id) || terminal.has(id)) {
            continue;
          }
          const supplied = live.get(id);
          if (supplied === undefined && source === 'pushed') continue;
          const provenance = supplied?.source ?? source;
          const prevs = supplied?.pdu.prev_events ?? node?.prevs ?? [];
          for (const prev of prevs) {
            const key = JSON.stringify([prev, provenance]);
            if (seen.has(key)) continue;
            seen.add(key);
            queue.push({ id: prev, source: provenance });
          }
        }
      }
      if (!this.active()) return null;
      if (stale) continue;
      this.saved = {
        head,
        supplied: new Set(live.keys()),
        boundaries: new Set(boundaries.keys()),
        terminal: new Set(terminal),
        nodes,
      };
      return this.saved;
    }
    return null;
  }
}
