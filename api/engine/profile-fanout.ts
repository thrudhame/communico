// Roll forward profile-owned desired membership through normal room submission.
// No tenant/server access occurs inside a retryable room transaction or signer.
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import type { Signer } from '#engine/room/signer.ts';
import { openRoom, type Room, type RoomTx } from '#engine/room/index.ts';
import { sendLocal } from '#engine/room/ingest.ts';
import { roomsFor } from '#engine/server/read.ts';
import { onProjected } from '#engine/server/project.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import {
  type ProfileFanout,
  SupersededProfile,
} from '#engine/tenant/profile-fanout.ts';
import { MatrixError } from '#engine/matrix-error.ts';

export type ProfileFanoutFailure = { room: string; error: unknown };
type Dependencies = {
  store: Store;
  tenant: Tenant;
  prepareSigner(work: ProfileFanout, room: string): Promise<Signer>;
  room?(id: string): Promise<Room>;
};

class DepartedProfileMember extends Error {}

async function currentMembership(tx: RoomTx, user: string) {
  const stay = await tx.segments.openStay();
  const group = stay === null ? null : await tx.state.current(stay.id);
  const id = group === null
    ? null
    : await tx.state.groupKey(group, 'm.room.member', user);
  const event = id === null ? null : await tx.events.get(id);
  return event === null
    ? null
    : JSON.parse(event.pdu).content as Record<string, unknown>;
}

export class ProfileFanoutWork {
  #tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: Dependencies) {}

  // One app-owned queue serializes notifications, startup and HTTP completion.
  // A failed room never prevents the remaining rooms/users from being attempted.
  drain(localpart?: string): Promise<ProfileFanoutFailure[]> {
    const run = this.#tail.catch(() => {}).then(() => this.#pass(localpart));
    this.#tail = run;
    return run;
  }

  async settled() {
    await this.#tail;
  }

  async #pass(localpart?: string): Promise<ProfileFanoutFailure[]> {
    const { tenant, store } = this.options;
    const server = await store.server();
    const failed: ProfileFanoutFailure[] = [];
    for (
      const first of await tenant.tx((tx) => tx.profiles.fanout.list(localpart))
    ) {
      const userFailed: ProfileFanoutFailure[] = [];
      let work: ProfileFanout | undefined = first;
      while (work) {
        const user = '@' + work.localpart + ':' + tenant.serverName;
        const rooms = (await roomsFor(server, user)).filter((m) =>
          m.membership === 'join'
        ).map((m) => m.roomId);
        const current: ProfileFanout = work;
        try {
          await tenant.tx((tx) => tx.profiles.fanout.discover(current, rooms));
          for (
            const result of await tenant.tx((tx) =>
              tx.profiles.fanout.rooms(current)
            )
          ) {
            try {
              if (result.completed) {
                if (result.accepted === false) {
                  throw new MatrixError(
                    403,
                    'M_FORBIDDEN',
                    'profile membership rejected',
                  );
                }
                continue;
              }
              await this.#deliver(current, result.room, user);
            } catch (error) {
              if (error instanceof SupersededProfile) break;
              userFailed.push({ room: result.room, error });
            }
          }
        } catch (error) {
          if (!(error instanceof SupersededProfile)) throw error;
        }
        // A winner committed while a PDU was in flight cannot lose its new
        // corrective work to the old completion. Revisit that revision now.
        const [latest] = await tenant.tx((tx) =>
          tx.profiles.fanout.list(current.localpart)
        );
        work = latest?.revision !== current.revision ? latest : undefined;
        if (work) userFailed.splice(0, userFailed.length);
      }
      failed.push(...userFailed);
    }
    return failed;
  }

  async #deliver(work: ProfileFanout, roomId: string, user: string) {
    const { tenant, store } = this.options;
    const room = await (this.options.room?.(roomId) ?? openRoom(store, roomId));
    const prepared = await tenant.tx((tx) =>
      tx.profiles.fanout.submission(work, roomId)
    );
    const { membership, receipt } = await room.tx(async (tx) => {
      const held = prepared === null
        ? null
        : await tx.events.get(prepared.eventId);
      return {
        membership: await currentMembership(tx, user),
        receipt: held === null
          ? null
          : await tx.events.getStatus(prepared!.eventId),
      };
    });
    if (receipt?.grounding === 'grounded') {
      const accepted = receipt.standing !== 'rejected';
      await tenant.tx((tx) =>
        tx.profiles.fanout.finish(work, roomId, prepared!.eventId, accepted)
      );
      if (!accepted) {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          'profile membership rejected',
        );
      }
      return;
    }
    if (
      membership?.membership !== 'join' || (prepared === null &&
        (membership.displayname === work.profile.displayname &&
          membership.avatar_url === work.profile.avatar_url))
    ) {
      await tenant.tx((tx) =>
        tx.profiles.fanout.finish(work, roomId, null, null)
      );
      return;
    }
    const content: Record<string, unknown> = {
      ...membership,
      membership: 'join',
    };
    for (const field of ['displayname', 'avatar_url'] as const) {
      if (work.profile[field] === undefined) delete content[field];
      else content[field] = work.profile[field];
    }
    const signer = await this.options.prepareSigner(work, roomId);
    try {
      const result = await sendLocal(
        room,
        {
          type: 'm.room.member',
          state_key: user,
          sender: user,
          content,
          origin_server_ts: Date.now(),
        },
        signer,
        {
          admit: async (tx) => {
            if ((await currentMembership(tx, user))?.membership !== 'join') {
              throw new DepartedProfileMember();
            }
          },
          lookup: () =>
            tenant.tx((tx) => tx.profiles.fanout.submission(work, roomId)),
          prepare: (pdu) =>
            tenant.tx((tx) => tx.profiles.fanout.prepare(work, roomId, pdu)),
          finish: (eventId, accepted) =>
            tenant.tx((tx) =>
              tx.profiles.fanout.finish(work, roomId, eventId, accepted)
            ),
        },
      );
      if (result.standing === 'rejected') {
        throw new MatrixError(
          403,
          'M_FORBIDDEN',
          'profile membership rejected',
        );
      }
    } catch (error) {
      if (!(error instanceof DepartedProfileMember)) throw error;
      // No room event was written. A retained preparation is not an accepted
      // join, and must never become a fresh join after the user has left.
      await tenant.tx((tx) =>
        tx.profiles.fanout.finish(work, roomId, null, null)
      );
    }
  }
}

export function startProfileFanout(
  options: Dependencies & { pollseconds: number; failed(error: unknown): void },
) {
  const work = new ProfileFanoutWork(options);
  let stopped = false, dirty = false;
  let running: Promise<void> | undefined;
  const wake = () => {
    if (stopped) return;
    dirty = true;
    running ??= (async () => {
      try {
        do {
          dirty = false;
          try {
            const failures = await work.drain();
            for (const failure of failures) options.failed(failure.error);
          } catch (error) {
            options.failed(error);
          }
        } while (dirty);
      } finally {
        running = undefined;
      }
    })();
  };
  const untenant = onTenantStream((store, name) => {
    if (store === options.store && name === options.tenant.serverName) wake();
  });
  const unproject = onProjected((store) => {
    if (store === options.store) wake();
  });
  const timer = setInterval(wake, options.pollseconds * 1000);
  wake();
  return {
    drain: (localpart?: string) => work.drain(localpart),
    async close() {
      stopped = true;
      clearInterval(timer);
      untenant();
      unproject();
      await running;
      await work.settled();
    },
  };
}
