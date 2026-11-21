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
import { canonicalJson } from '#engine/canonical.ts';
import { domainOf } from '#engine/ids.ts';
import { onProjected } from '#engine/server/project.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { Grant, Pairings } from './pairing.ts';
import { applyReplicaScope } from './scopes.ts';
import { requireSelectionReady } from './domain-control.ts';
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
  version?: 1 | 2,
): Promise<LinkRecord | null> {
  const db = await store.server();
  const scope = 'room:' + room.id;
  for (;;) {
    const [binding] = await db.query(
      'SELECT side,node,state,revision,grant_json FROM facade_pairings WHERE id=?',
      [pairing],
    );
    const reverse = binding?.side === 'facade';
    const grant = binding?.grant_json
      ? JSON.parse(String(binding.grant_json)) as Grant
      : null;
    const context = grant?.body.transcript.body.context;
    if (
      !grant || !context || binding?.state !== 'paired' ||
      Number(binding.revision) !== grant.body.revision ||
      context.id !== pairing || context.server !== self ||
      context.node !== binding.node ||
      (reverse
        ? peer !== 'home'
        : binding.side !== 'home' || binding.node !== peer)
    ) {
      throw new LinkError(
        'LINK_UNPAIRED',
        'room export requires active pairing',
        403,
      );
    }
    const wireVersion = version ?? (reverse ? 2 : 1);
    if (reverse && wireVersion !== 2) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'reverse room export requires version 2',
      );
    }
    const source = reverse ? context.node : 'home';
    const incarnation = reverse
      ? grant.body.transcript.body.incarnation
      : pairing;
    const [prior] = await db.query(
      'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
      [peer, pairing, scope],
    );
    const after = prior ? Number(prior.source_cut) : 0;
    const manifest = await exportReplicaRoom(room, self, after);
    if (prior && manifest.cut === after) return null;
    const result = await db.tx(async (conn) => {
      const [currentBinding] = await conn.query(
        'SELECT state,revision,grant_json FROM facade_pairings WHERE id=? AND side=?',
        [pairing, reverse ? 'facade' : 'home'],
      );
      if (
        currentBinding?.state !== 'paired' ||
        Number(currentBinding.revision) !== grant.body.revision ||
        currentBinding.grant_json !== canonicalJson(grant)
      ) {
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
        source,
        incarnation,
        stream: scope,
        type: 'room-replica',
        version: wireVersion,
        operationId: wireVersion === 1
          ? `room:${pairing}:${room.id}:${manifest.cut}`
          : `room:${pairing}:${source}:${room.id}:${manifest.cut}`,
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
  version?: 1 | 2;
  changed(): void;
  failed(error: unknown, roomId?: string): void;
}) {
  let stopped = false;
  let scanning: Promise<void> | undefined;
  const running = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  let dirty = false;
  const wake = () => {
    if (stopped) return;
    dirty = true;
    scanning ??= (async () => {
      try {
        do {
          dirty = false;
          try {
            for (const id of await options.store.rooms()) {
              if (stopped) break;
              if (running.has(id)) {
                rerun.add(id);
                continue;
              }
              const job = (async () => {
                try {
                  do {
                    rerun.delete(id);
                    try {
                      const room = await openRoom(options.store, id);
                      // Evidence-only/prejoin files carry no authentic participation.
                      if (!await room.tx((tx) => tx.segments.latestStay())) {
                        continue;
                      }
                      if (
                        await exportRoomReplica(
                          options.store,
                          room,
                          options.self,
                          options.peer,
                          options.pairing,
                          options.version,
                        )
                      ) {
                        options.changed();
                      }
                    } catch (error) {
                      options.failed(error, id);
                    }
                  } while (!stopped && rerun.delete(id));
                } finally {
                  running.delete(id);
                }
              })();
              running.set(id, job);
            }
          } catch (error) {
            options.failed(error);
          }
        } while (!stopped && dirty);
      } finally {
        scanning = undefined;
      }
    })();
  };
  const unproject = onProjected((store) => {
    if (store === options.store) wake();
  });
  let closed: Promise<void> | undefined;
  return {
    wake,
    close: () =>
      closed ??= (async () => {
        stopped = true;
        unproject();
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

  async apply(
    journal: Journal,
    stream: Stream,
    pairing?: string,
  ): Promise<boolean> {
    const connection = pairing
      ? await this.pairings.connection(pairing)
      : undefined;
    const peer = connection ? connection.context.node : 'home';
    const record = await journal.next(peer, stream);
    if (!record) return false;
    if (
      record.type !== 'room-replica' ||
      (record.version !== 1 && record.version !== 2) ||
      (connection && record.version !== 2)
    ) {
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
      pairing,
      // A reverse bootstrap either extends our own retained room export or
      // carries authentic participation by an account selected for this peer.
      // The room owner still verifies every event before installing anything.
      authorize: connection
        ? async (conn) => {
          const [known] = await conn.query(
            'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
            [peer, pairing!, scope],
          );
          if (known) return;
          const openings = new Set(
            manifest.stays.map((stay) => stay.opening.eventId),
          );
          let participation = false;
          for (const event of manifest.events) {
            if (
              !openings.has(String(event.event_id)) ||
              event.type !== 'm.room.member' ||
              event.sender !== event.state_key ||
              domainOf(event.sender) !== this.self ||
              event.content?.membership !== 'join'
            ) continue;
            participation = true;
            const [selected] = await conn.query(
              'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
              [peer, pairing!, 'auth:' + event.sender],
            );
            if (selected) return;
          }
          if (participation) {
            requireSelectionReady(
              false,
              'room awaits selected account participation',
            );
          }
          throw new LinkError(
            'LINK_IDENTITY_MISMATCH',
            'room has no selected account participation',
            403,
          );
        }
        : undefined,
      apply: async () => {
        await importReplicaRoom(this.store, manifest, {
          self: this.self,
          keys: this.keys,
          signatureUnion: record.version === 2,
        });
        return { roomId: manifest.roomId, cut: manifest.cut };
      },
    });
  }
}
