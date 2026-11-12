// App-owned scheduler. The tenant owns commands; rooms own authorization,
// publication history and event ingestion. No cross-file transaction nesting.
import type { App } from '#engine/app.ts';
import { config } from '#engine/config.ts';
import { assertCanonicalNumbers } from '#engine/canonical.ts';
import { localpartOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { requireRoom } from '#engine/client/room.ts';
import { openRoom, type RoomTx } from '#engine/room/index.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { assertLocalEncryption } from '#engine/room/encryption-policy.ts';
import { deviceIdentity } from '#engine/tenant/txns.ts';
import { type DelayedEvent, notFound } from '#engine/tenant/delayed-events.ts';

export function delayedEventsEnabled(): boolean {
  const limits = config().delayedevents;
  return limits.maxdelayms > 0 && limits.maxperuser > 0;
}
export function requestedDelay(query: URLSearchParams): number | null {
  const raw = query.get('org.matrix.msc4140.delay');
  if (raw === null) return null;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'delay must be nonnegative integer milliseconds',
    );
  }
  return value;
}
function response(e: DelayedEvent, legacy = false) {
  return {
    delay_id: e.id,
    room_id: e.roomId,
    type: e.type,
    ...(e.stateKey === null ? {} : { state_key: e.stateKey }),
    content: e.content,
    delay_ms: e.delay,
    delayed_since_ts: e.since,
    ...(legacy ? { delay: e.delay, running_since: e.since } : {}),
  };
}
async function currentKey(tx: RoomTx, type: string, key: string) {
  const stay = await tx.segments.openStay();
  const group = stay === null ? null : await tx.state.current(stay.id);
  return group === null ? null : await tx.state.groupKey(group, type, key);
}

async function requireJoined(tx: RoomTx, userId: string): Promise<void> {
  const member = await currentKey(tx, 'm.room.member', userId);
  const event = member === null ? null : await tx.events.get(member);
  if (event === null || JSON.parse(event.pdu).content?.membership !== 'join') {
    throw new MatrixError(403, 'M_FORBIDDEN', 'not joined');
  }
}

export class DelayedEvents {
  #app: Pick<App, 'tenant' | 'store'>;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running: Promise<void> | null = null;
  #stopped = false;
  #wakeAgain = false;
  // Per-command management and timeout share a serialization boundary. Room
  // mutations retain their own lock; this map never encloses a tenant tx.
  #locks = new Map<string, Promise<unknown>>();
  constructor(app: Pick<App, 'tenant' | 'store'>) {
    this.#app = app;
  }
  async #locked<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.#locks.get(id) ?? Promise.resolve();
    const job = prior.catch(() => {}).then(fn);
    this.#locks.set(id, job);
    try {
      return await job;
    } finally {
      if (this.#locks.get(id) === job) this.#locks.delete(id);
    }
  }
  async schedule(input: {
    userId: string;
    roomId: string;
    type: string;
    stateKey: string | null;
    content: Record<string, unknown>;
    delay: number;
    deviceId: string | null;
    generation?: number;
    txnId?: string;
  }): Promise<{ delay_id: string }> {
    const { tenant } = this.#app;
    if (!delayedEventsEnabled()) {
      throw new MatrixError(403, 'M_FORBIDDEN', 'delayed events disabled');
    }
    if (!Number.isSafeInteger(input.delay) || input.delay < 0) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid delay');
    }
    if (
      input.delay > config().delayedevents.maxdelayms ||
      !Number.isSafeInteger(Date.now() + input.delay)
    ) {
      throw new MatrixError(
        400,
        'M_DELAY_TOO_LARGE',
        'delay exceeds configured maximum',
      );
    }
    if (
      !input.content || typeof input.content !== 'object' ||
      Array.isArray(input.content)
    ) throw new MatrixError(400, 'M_BAD_JSON', 'content must be an object');
    assertCanonicalNumbers(input.content);
    if (input.type === 'm.room.create') {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'room already created');
    }
    const localpart = localpartOf(input.userId);
    const receipt = input.txnId !== undefined && input.deviceId !== null
      ? {
        device: await deviceIdentity(
          tenant,
          localpart,
          input.deviceId,
          input.generation,
        ),
        endpoint: JSON.stringify([input.roomId, input.type]),
        txnId: input.txnId,
      }
      : undefined;
    if (receipt) {
      const old = await tenant.tx((tx) => tx.delayedEvents.receipt(receipt));
      if (old !== null) return { delay_id: old };
    }
    const room = await requireRoom(input.roomId);
    const id = await withRoomLock(input.roomId, async () => {
      const cut = await room.tx(async (tx) => {
        await requireJoined(tx, input.userId);
        const stay = await tx.segments.openStay();
        const group = stay === null ? null : await tx.state.current(stay.id);
        await assertLocalEncryption(tx, group, {
          type: input.type,
          sender: input.userId,
          content: input.content,
          ...(input.stateKey === null ? {} : { state_key: input.stateKey }),
        }, tenant.serverName);
        return {
          roomPos: await tx.changes.head(),
          stateEvent: input.stateKey === null
            ? null
            : await currentKey(tx, input.type, input.stateKey),
        };
      });
      const now = Date.now();
      return await tenant.tx((tx) =>
        tx.delayedEvents.add(
          {
            id: crypto.randomUUID(),
            localpart,
            roomId: input.roomId,
            type: input.type,
            stateKey: input.stateKey,
            content: input.content,
            delay: input.delay,
            since: now,
            due: now + input.delay,
            ...cut,
            phase: 'pending',
          },
          config().delayedevents.maxperuser,
          receipt,
        )
      );
    });
    this.wake();
    return { delay_id: id };
  }
  async #cancelled(e: DelayedEvent, tx: RoomTx): Promise<boolean> {
    return e.stateKey !== null &&
      await tx.state.changedByOther(
        e.type,
        e.stateKey,
        '@' + e.localpart + ':' + this.#app.tenant.serverName,
        e.roomPos,
        e.stateEvent,
      );
  }
  async #reconcile(e: DelayedEvent): Promise<boolean> {
    if (e.phase !== 'pending' || e.stateKey === null) return false;
    const room = await openRoom(this.#app.store, e.roomId);
    if (!await room.tx((tx) => this.#cancelled(e, tx))) return false;
    await this.#app.tenant.tx((tx) => tx.delayedEvents.remove(e.id));
    return true;
  }
  async list(userId: string, id?: string) {
    const events = await this.#app.tenant.tx((tx) =>
      tx.delayedEvents.list(localpartOf(userId))
    );
    const out: ReturnType<typeof response>[] = [];
    for (const event of events) {
      if (id !== undefined && event.id !== id) continue;
      await this.#locked(event.id, async () => {
        const current = await this.#app.tenant.tx((tx) =>
          tx.delayedEvents.get(event.id)
        );
        if (
          current !== null && current.phase === 'pending' &&
          !await this.#reconcile(current)
        ) out.push(response(current, id === undefined));
      });
    }
    if (id !== undefined) return out[0] ?? notFound();
    return { delayed_events: out };
  }
  async action(id: string, action: unknown): Promise<Record<string, never>> {
    if (
      typeof action !== 'string' ||
      !['cancel', 'restart', 'send'].includes(action)
    ) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'unknown delayed event action',
      );
    }
    try {
      await this.#locked(id, async () => {
        const event = await this.#app.tenant.tx((tx) =>
          tx.delayedEvents.get(id)
        );
        if (
          event === null || event.phase !== 'pending' ||
          await this.#reconcile(event)
        ) notFound();
        await this.#app.tenant.tx((tx) =>
          tx.delayedEvents.action(
            id,
            action as 'cancel' | 'restart' | 'send',
            Date.now(),
          )
        );
        if (action === 'send') await this.#deliver(id);
      });
    } finally {
      this.wake();
    }
    return {};
  }
  async #deliver(id: string) {
    const { tenant, store } = this.#app;
    const e = await tenant.tx((tx) => tx.delayedEvents.claim(id, Date.now()));
    if (e === null) return;
    try {
      const room = await openRoom(store, e.roomId);
      const submission = {
        lookup: () => tenant.tx((tx) => tx.delayedEvents.submission(id)),
        prepare: (pdu: import('#engine/pdu.ts').Pdu) =>
          tenant.tx((tx) => tx.delayedEvents.prepare(id, pdu)),
        finish: () => tenant.tx((tx) => tx.delayedEvents.finish(id)),
        admit: async (tx: RoomTx) => {
          if (await this.#cancelled(e, tx)) notFound();
          await requireJoined(tx, '@' + e.localpart + ':' + tenant.serverName);
        },
      };
      const user = await tenant.tx((tx) => tx.users.byLocalpart(e.localpart));
      if (user === null || user.deactivated) {
        await tenant.tx((tx) => tx.delayedEvents.remove(id));
        return;
      }
      const result = await sendLocal(
        room,
        {
          type: e.type,
          sender: '@' + e.localpart + ':' + tenant.serverName,
          content: e.content,
          ...(e.stateKey === null ? {} : { state_key: e.stateKey }),
          origin_server_ts: Date.now(),
        },
        tenant.signer(),
        submission,
      );
      await tenant.tx((tx) => tx.delayedEvents.remove(id));
      if (result.standing !== 'accepted') {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          'delayed event no longer authorized',
        );
      }
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        (error instanceof MatrixError && error.status >= 400 &&
          error.status < 500)
      ) {
        await tenant.tx((tx) => tx.delayedEvents.remove(id));
      } else {
        await tenant.tx((tx) =>
          tx.delayedEvents.retry([id], Date.now() + 1000)
        );
      }
      throw error;
    }
  }
  async drain(): Promise<void> {
    if (this.#stopped) return;
    const events = await this.#app.tenant.tx((tx) =>
      tx.delayedEvents.due(Date.now())
    );
    const retained: string[] = [];
    for (const event of events) {
      if (this.#stopped) break;
      try {
        await this.#locked(event.id, () => this.#deliver(event.id));
      } catch (error) {
        // Never log delay bearer IDs, content or network/client metadata.
        if (!(error instanceof MatrixError)) {
          console.error('delayed event delivery failed; retry pending');
        }
        retained.push(event.id);
      }
    }
    // Rebase the whole failed batch after processing it. Even a slow batch
    // must leave a window for later due commands, not refill its own 32 slots.
    if (retained.length !== 0) {
      await this.#app.tenant.tx((tx) =>
        tx.delayedEvents.retry(retained, Date.now() + 1000)
      );
    }
  }
  wake(): void {
    if (this.#stopped) return;
    if (this.#running !== null) {
      this.#wakeAgain = true;
      return;
    }
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#running = this.drain().finally(async () => {
      try {
        const next = await this.#app.tenant.tx((tx) => tx.delayedEvents.next());
        if (!this.#stopped && next !== null) {
          this.#timer = setTimeout(
            () => this.wake(),
            next <= Date.now() ? 1000 : Math.min(2147483647, next - Date.now()),
          );
        }
      } catch {
        // Storage failures must not discard the scheduler's only future wake.
        if (!this.#stopped) {
          this.#timer = setTimeout(() => this.wake(), 1000);
        }
      } finally {
        this.#running = null;
        if (this.#wakeAgain) {
          this.#wakeAgain = false;
          this.wake();
        }
      }
    });
    this.#running.catch(() => {});
  }
  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#running;
    await Promise.allSettled(this.#locks.values());
  }
}
