// Room-first semantic export and recoverable cross-file application. Journal
// bytes pin the bootstrap/closure before its source watermark can advance.
import type { KeyResolver } from '#engine/room/deps.ts';
import { openRoom, type Room } from '#engine/room/index.ts';
import {
  exportReplicaRoom,
  importReplicaRoom,
  type ReplicaRoom,
} from '#engine/room/replica.ts';
import type { Store } from '#engine/store/index.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
import { applyReplicaScope } from './scopes.ts';
import {
  integer,
  LinkError,
  type LinkRecord,
  object,
  type Stream,
  text,
} from './protocol.ts';

function manifestOf(raw: unknown): ReplicaRoom {
  const value = object(raw);
  if (
    value.version !== 1 || !Array.isArray(value.stays) ||
    !Array.isArray(value.steps) ||
    !Array.isArray(value.events) || !Array.isArray(value.boundaries)
  ) {
    throw new LinkError('LINK_BAD_RECORD', 'invalid room manifest', 400);
  }
  text(value.roomId);
  text(value.roomVersion);
  const after = integer(value.after), cut = integer(value.cut);
  if (after > cut) {
    throw new LinkError('LINK_DIVERGED', 'regressing source cut');
  }
  return value as unknown as ReplicaRoom;
}

export async function exportRoomReplica(
  store: Store,
  room: Room,
  self: string,
  peer: string,
  pairing: string,
): Promise<LinkRecord | null> {
  const db = await store.server();
  const scope = 'room:' + room.id;
  for (;;) {
    const [prior] = await db.query(
      'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
      [peer, pairing, scope],
    );
    const after = prior ? Number(prior.source_cut) : 0;
    const manifest = await exportReplicaRoom(room, self, after);
    if (prior && manifest.cut === after) return null;
    const result = await db.tx(async (conn) => {
      const [binding] = await conn.query(
        "SELECT node,state FROM facade_pairings WHERE id=? AND side='home'",
        [pairing],
      );
      if (binding?.node !== peer || binding.state !== 'paired') {
        throw new LinkError(
          'LINK_UNPAIRED',
          'room export requires active pairing',
          403,
        );
      }
      const [current] = await conn.query(
        'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
        [peer, pairing, scope],
      );
      if ((current ? Number(current.source_cut) : 0) !== after) return null;
      const record = await appendRecord(conn, peer, {
        source: 'home',
        incarnation: pairing,
        stream: scope,
        type: 'room-replica',
        version: 1,
        operationId: `room:${pairing}:${room.id}:${manifest.cut}`,
        payload: { kind: 'room-replica', manifest },
      });
      await conn.execute(
        'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
        [peer, pairing, scope, manifest.cut],
      );
      return record;
    });
    if (result) return result;
  }
}

/** Each retained local participation has an independent export owner. A failed
 * or busy room cannot stop enumeration or hold another room's source watermark.
 * Existing changes are the durable intent, so restart needs no volatile queue. */
export function startRoomExports(options: {
  store: Store;
  self: string;
  peer: string;
  pairing: string;
  changed(): void;
  failed(error: unknown, roomId?: string): void;
}) {
  let stopped = false;
  let scanning: Promise<void> | undefined;
  const running = new Map<string, Promise<void>>();
  const wake = () => {
    if (stopped) return;
    scanning ??= (async () => {
      try {
        for (const id of await options.store.rooms()) {
          if (stopped || running.has(id)) continue;
          const job = (async () => {
            const room = await openRoom(options.store, id);
            // Evidence-only/prejoin files carry no authentic participation.
            if (!await room.tx((tx) => tx.segments.latestStay())) return;
            if (
              await exportRoomReplica(
                options.store,
                room,
                options.self,
                options.peer,
                options.pairing,
              )
            ) {
              options.changed();
            }
          })().catch((error) => options.failed(error, id));
          running.set(id, job);
          void job.finally(() => running.delete(id));
        }
      } catch (error) {
        options.failed(error);
      } finally {
        scanning = undefined;
      }
    })();
  };
  let closed: Promise<void> | undefined;
  return {
    wake,
    close: () =>
      closed ??= (async () => {
        stopped = true;
        await scanning;
        await Promise.all(running.values());
      })(),
  };
}

export class RoomReplicas {
  constructor(
    private readonly store: Store,
    private readonly pairings: Pairings,
    private readonly self: string,
    private readonly keys: KeyResolver,
  ) {}

  async scopes(incarnation?: string) {
    const binding = incarnation ??
      (await this.pairings.active()).body.transcript.body.context.id;
    const rows = await (await this.store.server()).query(
      'SELECT scope,source_cut,ready,pending_hash FROM facade_scopes WHERE incarnation=? ORDER BY scope',
      [binding],
    );
    return rows.map((row) => ({
      scope: String(row.scope),
      cut: Number(row.source_cut),
      ready: Number(row.ready) === 1,
      pending: row.pending_hash === null ? null : String(row.pending_hash),
    }));
  }

  async status(roomId: string) {
    const grant = await this.pairings.active();
    const db = await this.store.server();
    const [held] = await db.query(
      'SELECT source_cut,ready,pending_hash FROM facade_scopes WHERE incarnation=? AND scope=?',
      [grant.body.transcript.body.context.id, 'room:' + roomId],
    );
    return held
      ? {
        cut: Number(held.source_cut),
        ready: Number(held.ready) === 1,
        pending: held.pending_hash === null ? null : String(held.pending_hash),
      }
      : null;
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (record.type !== 'room-replica' || record.version !== 1) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not a room replica');
    }
    const payload = object(record.payload);
    if (payload.kind !== 'room-replica') {
      throw new LinkError('LINK_BAD_RECORD', 'unknown room operation', 400);
    }
    const manifest = manifestOf(payload.manifest);
    const scope = 'room:' + manifest.roomId;
    return await applyReplicaScope({
      db: await this.store.server(),
      pairings: this.pairings,
      self: this.self,
      journal,
      stream,
      record,
      scope,
      after: manifest.after,
      cut: manifest.cut,
      apply: async () => {
        await importReplicaRoom(this.store, manifest, {
          self: this.self,
          keys: this.keys,
        });
        return { roomId: manifest.roomId, cut: manifest.cut };
      },
    });
  }
}
