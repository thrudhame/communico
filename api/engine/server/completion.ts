// One store-lifetime owner of durable room completion. Requests own only their
// immutable waiter; room truth owns work after disconnect, lost wake or failure.
import type { Store } from '#engine/store/index.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import type {
  CompletionCut,
  CompletionTarget,
} from '#engine/room/completion.ts';
import { resumeWaits } from '#engine/room/ingest.ts';
import { completePublished, publishThrough, sourceOf } from './project.ts';
import { get } from '#engine/store/watermark.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { workerFailure } from '#engine/request-diagnostics.ts';

type Target = CompletionCut | CompletionTarget;
type Phase = 'publication' | 'completion';
type Waiter = {
  target: Target;
  phase: Phase;
  resolve(): void;
  reject(error: unknown): void;
};
type Demand = {
  room: Room;
  self: string;
  target: Target;
  running?: Promise<void>;
  ready?: Promise<CompletionCut>;
  callbacks: Map<number, Promise<void>>;
  waiters: Set<Waiter>;
  failure?: CompletionFailure;
};

export class CompletionFailure extends MatrixError {
  override readonly cause: unknown;
  constructor(readonly target: Target, readonly phase: Phase, cause: unknown) {
    super(
      503,
      'M_UNAVAILABLE',
      `room completion failed: ${target.roomId}/${target.through} (${phase})`,
    );
    this.cause = cause;
  }
}

const owners = new WeakMap<Store, RoomCompletion>();
export function completionService(store: Store): RoomCompletion {
  let owner = owners.get(store);
  if (owner === undefined) {
    owner = new RoomCompletion(store);
    owners.set(store, owner);
    store.onDrain(() => owner!.close());
  }
  return owner;
}

export class RoomCompletion {
  private readonly rooms = new Map<string, Demand>();
  private timer?: ReturnType<typeof setTimeout>;
  private closing = false;
  constructor(private readonly store: Store) {}

  // Completed arrival helpers include the ready children their arrival grounds.
  // This shares the worker's drain; ordinary publication waiters keep their
  // original fixed cut and never inherit this dependent-composition tail.
  async complete(
    room: Room,
    self: string,
    target: Target,
    signal?: AbortSignal,
  ): Promise<void> {
    const demand = this.enroll(room, self, target);
    signal?.throwIfAborted();
    let tail: CompletionCut;
    try {
      tail = await this.ready(demand);
    } catch (cause) {
      signal?.throwIfAborted();
      throw new CompletionFailure(target, 'completion', cause);
    }
    // A shared readiness pass may have captured before this caller committed.
    // Include its dependent tail without replacing the caller's own obligation.
    const required = tail.through < target.through ? target : tail;
    this.enroll(room, self, required);
    await this.wait(required, 'completion', signal, self);
  }

  private ready(demand: Demand): Promise<CompletionCut> {
    if (demand.ready !== undefined) return demand.ready;
    const task = Promise.resolve().then(async () => {
      await resumeWaits(demand.room, { self: demand.self }, []);
      return await demand.room.tx((tx) => tx.completion.capture());
    });
    demand.ready = task;
    const release = () => {
      if (demand.ready === task) demand.ready = undefined;
      this.releaseIdle(demand);
    };
    void task.then(release, release);
    return task;
  }

  enroll(room: Room, self: string, target: Target): Demand {
    if (this.closing) {
      throw new CompletionFailure(
        target,
        'publication',
        new Error('E_COMPLETION_OWNER_CLOSED'),
      );
    }
    let demand = this.rooms.get(room.id);
    if (demand === undefined) {
      demand = { room, self, target, callbacks: new Map(), waiters: new Set() };
      this.rooms.set(room.id, demand);
    } else if (demand.target.generation !== target.generation) {
      throw new CompletionFailure(
        target,
        'publication',
        new Error('E_COMPLETION_GENERATION'),
      );
    } else if (target.through > demand.target.through) {
      demand.target = target;
    }
    this.start(demand);
    return demand;
  }

  async wait(
    target: Target,
    phase: Phase,
    signal?: AbortSignal,
    self?: string,
  ): Promise<void> {
    signal?.throwIfAborted();
    let room: Room;
    try {
      room = await openRoom(this.store, target.roomId);
      // Revalidate the persisted generation AND this runtime room capability even
      // when its numeric publication position has already been satisfied.
      await room.tx((tx) => tx.completion.validate(target));
    } catch (cause) {
      signal?.throwIfAborted();
      throw new CompletionFailure(target, phase, cause);
    }
    signal?.throwIfAborted();
    const demand = this.enroll(
      room,
      self ?? (await this.store.tenants())[0] ?? '',
      target,
    );
    const result = Promise.withResolvers<void>();
    void result.promise.catch(() => {});
    const waiter: Waiter = {
      target,
      phase,
      resolve: () => result.resolve(),
      reject: result.reject,
    };
    demand.waiters.add(waiter);
    const abort = () => result.reject(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      try {
        await this.refresh(demand);
      } catch (cause) {
        throw new CompletionFailure(target, phase, cause);
      }
      await result.promise;
    } finally {
      signal?.removeEventListener('abort', abort);
      demand.waiters.delete(waiter);
      this.releaseIdle(demand);
    }
  }

  private releaseIdle(demand: Demand): void {
    if (
      this.rooms.get(demand.room.id) === demand &&
      demand.running === undefined && demand.ready === undefined &&
      demand.waiters.size === 0 && demand.callbacks.size === 0 &&
      demand.failure === undefined
    ) this.rooms.delete(demand.room.id);
  }

  private fail(
    demand: Demand,
    target: Target,
    phase: Phase,
    cause: unknown,
  ): void {
    const failure = new CompletionFailure(target, phase, cause);
    // An unattended durable obligation has the same failure contract as a waiter.
    // Log the transition, not every timer retry of the same failed cut/phase.
    if (
      demand.failure?.target.through !== target.through ||
      demand.failure?.phase !== phase || demand.failure?.cause !== cause
    ) {
      workerFailure({
        owner: 'room completion',
        server: demand.self,
        scope: `${target.roomId}/${target.through} (${phase})`,
      }, failure);
    }
    demand.failure = failure;
    for (const waiter of [...demand.waiters]) {
      if (
        waiter.target.through > target.through ||
        (phase === 'completion' && waiter.phase === 'publication')
      ) continue;
      demand.waiters.delete(waiter);
      waiter.reject(new CompletionFailure(waiter.target, phase, cause));
    }
  }

  private async refresh(demand: Demand): Promise<void> {
    const state = await demand.room.tx((tx) => tx.completion.state());
    const published = await get(
      await this.store.server(),
      sourceOf(demand.room.id),
    );
    for (const waiter of [...demand.waiters]) {
      if (waiter.target.generation !== state.generation) {
        demand.waiters.delete(waiter);
        waiter.reject(
          new CompletionFailure(
            waiter.target,
            waiter.phase,
            new Error('E_COMPLETION_GENERATION'),
          ),
        );
      } else if (
        (waiter.phase === 'publication' ? published : state.completedThrough) >=
          waiter.target.through
      ) {
        demand.waiters.delete(waiter);
        waiter.resolve();
      } else if (
        waiter.phase === 'completion' && published >= waiter.target.through
      ) {
        // A smaller callback waiter never waits for the worker's larger cut.
        this.callbacks(demand, waiter.target);
      }
    }
  }

  private callbacks(demand: Demand, target: Target): Promise<void> {
    const existing = demand.callbacks.get(target.through);
    if (existing !== undefined) return existing;
    const task = completePublished(this.store, target).then(
      () => this.refresh(demand),
      (error) => {
        this.fail(demand, target, 'completion', error);
        this.retry();
        throw error;
      },
    );
    demand.callbacks.set(target.through, task);
    // Owned by the demand, including failures observed by the worker or close.
    const release = () => {
      if (demand.callbacks.get(target.through) === task) {
        demand.callbacks.delete(target.through);
      }
      this.releaseIdle(demand);
    };
    void task.then(release, release);
    return task;
  }

  private start(demand: Demand): void {
    if (demand.running !== undefined || this.closing) return;
    const failure = demand.failure;
    const target = failure?.target ?? demand.target;
    let phase: Phase = 'publication';
    const run = Promise.resolve().then(async () => {
      const tail = await this.ready(demand);
      if (tail.through > demand.target.through) demand.target = tail;
      const state = await demand.room.tx((tx) => tx.completion.state());
      if (
        state.completedThrough >= target.through &&
        failure?.phase !== 'completion'
      ) {
        await this.refresh(demand);
        if (demand.failure === failure) demand.failure = undefined;
        return;
      }
      await publishThrough(this.store, target, () => this.refresh(demand));
      phase = 'completion';
      await this.callbacks(demand, target);
      await this.refresh(demand);
      // A late callback from another cut can fail while this worker succeeds.
      // Only clear the failure this run actually retried, never that newer work.
      if (demand.failure === failure) demand.failure = undefined;
    });
    demand.running = run;
    void run.then(() => {
      demand.running = undefined;
      if (demand.failure !== undefined) this.retry();
      else if (demand.target.through > target.through) this.start(demand);
      this.releaseIdle(demand);
    }, (error) => {
      demand.running = undefined;
      this.fail(demand, target, phase, error);
      this.retry();
    });
  }

  private retry(): void {
    if (this.timer !== undefined || this.closing) return;
    // Scheduling backoff, not a deadline, retry limit or lost durable tail.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const demand of this.rooms.values()) this.start(demand);
    }, 100);
  }

  async discover(self: string): Promise<void> {
    for (const roomId of await this.store.rooms()) {
      const room = await openRoom(this.store, roomId);
      const target = await room.tx((tx) => tx.completion.capture());
      await this.wait(target, 'completion', undefined, self);
    }
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    // No new acceptance can reach this point: Store first drains admitted writes.
    // Finish each current immutable demand, then any dependency tail it produced.
    try {
      for (;;) {
        const demands = [...this.rooms.values()];
        if (demands.length === 0) break;
        for (const demand of demands) this.start(demand);
        await Promise.all(
          demands.flatMap((d) => [d.running!, ...d.callbacks.values()]),
        );
        for (const demand of demands) {
          this.releaseIdle(demand);
        }
      }
    } finally {
      this.closing = true;
      clearTimeout(this.timer);
      await Promise.allSettled(
        [...this.rooms.values()].flatMap((
          d,
        ) => [d.running, ...d.callbacks.values()]),
      );
    }
  }
}
