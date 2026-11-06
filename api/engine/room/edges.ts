// Immutable forward edges only. A cache entry certifies an EXISTING event;
// absence is not immutable and must never be cached. No database handles live
// here. All fills and LRU touches are published after a successful commit.
export type EdgeKind = 'auth' | 'prev';
type Edges = Partial<Record<EdgeKind, readonly string[]>>;
type Entry = {
  owner: symbol;
  room: string;
  id: string;
  edges: Edges;
  version: number;
};

export class EdgeCache {
  private readonly owners = new WeakMap<object, symbol>();
  private readonly rooms = new Map<symbol, Map<string, Map<string, Entry>>>();
  private readonly lru = new Map<Entry, true>();
  private generation = 0;

  constructor(
    private readonly roomLimit = 100_000,
    private readonly globalLimit = 1_000_000,
  ) {
    if (
      !Number.isSafeInteger(roomLimit) || roomLimit < 1 ||
      !Number.isSafeInteger(globalLimit) || globalLimit < 1
    ) throw new TypeError('invalid edge cache limit');
  }

  // Capture before invoking Database.tx (and thus before BEGIN). A retry may
  // conservatively reuse this cutoff; its attempt-local overlay is always new.
  cutoff(): number {
    return this.generation;
  }

  attempt(owner: object, room: string, cutoff: number): EdgeOverlay {
    let token = this.owners.get(owner);
    if (token === undefined) {
      token = Symbol();
      this.owners.set(owner, token);
    }
    return new EdgeOverlay(this, token, room, cutoff);
  }

  peek(
    owner: symbol,
    room: string,
    id: string,
    cutoff: number,
  ): Edges | undefined {
    const entry = this.rooms.get(owner)?.get(room)?.get(id);
    return entry !== undefined && entry.version <= cutoff
      ? entry.edges
      : undefined;
  }

  private remove(entry: Entry) {
    this.lru.delete(entry);
    const rooms = this.rooms.get(entry.owner)!;
    const room = rooms.get(entry.room)!;
    room.delete(entry.id);
    if (room.size === 0) rooms.delete(entry.room);
    if (rooms.size === 0) this.rooms.delete(entry.owner);
  }

  merge(owner: symbol, name: string, batch: ReadonlyMap<string, Edges>) {
    for (const [id, edges] of batch) {
      let rooms = this.rooms.get(owner);
      if (rooms === undefined) {
        rooms = new Map();
        this.rooms.set(owner, rooms);
      }
      let room = rooms.get(name);
      if (room === undefined) {
        room = new Map();
        rooms.set(name, room);
      }
      const old = room.get(id);
      if (old !== undefined) {
        room.delete(id);
        this.lru.delete(old);
      }
      const entry = {
        owner,
        room: name,
        id,
        edges: { ...old?.edges, ...edges },
        // The version certifies event existence, not recency. A committed
        // touch (or learning the other edge kind) cannot make an immutable
        // event invisible to an older snapshot that already knew it.
        version: old?.version ?? ++this.generation,
      };
      room.set(id, entry);
      this.lru.set(entry, true);
      if (room.size > this.roomLimit) this.remove(room.values().next().value!);
      if (this.lru.size > this.globalLimit) {
        this.remove(this.lru.keys().next().value!);
      }
    }
  }
}

export class EdgeOverlay {
  private readonly values = new Map<string, Edges>();
  private active = true;
  constructor(
    private readonly cache: EdgeCache,
    private readonly owner: symbol,
    private readonly room: string,
    private readonly cutoff: number,
  ) {}

  private check() {
    if (!this.active) {
      throw new Error('transaction edge overlay has been released');
    }
  }

  release() {
    this.active = false;
  }

  get(id: string, kind: EdgeKind): readonly string[] | undefined {
    this.check();
    const local = this.values.get(id)?.[kind];
    if (local !== undefined) return local;
    const edges = this.cache.peek(this.owner, this.room, id, this.cutoff);
    if (edges?.[kind] !== undefined) this.set(id, kind, edges[kind]);
    return edges?.[kind];
  }

  set(id: string, kind: EdgeKind, ids: readonly string[]) {
    this.check();
    this.values.set(id, {
      ...this.values.get(id),
      [kind]: Object.freeze([...ids]),
    });
  }

  commit() {
    this.cache.merge(this.owner, this.room, this.values);
  }
}

export const roomEdges = new EdgeCache();
