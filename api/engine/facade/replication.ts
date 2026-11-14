// Room-first semantic export and recoverable cross-file application. Journal
// bytes pin the bootstrap/closure before its source watermark can advance.
import type { KeyResolver } from '#engine/room/deps.ts';
import type { Room } from '#engine/room/index.ts';
import {
  exportReplicaRoom,
  importReplicaRoom,
  type ReplicaRoom,
} from '#engine/room/replica.ts';
import type { Store } from '#engine/store/index.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
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

export class RoomReplicas {
  constructor(
    private readonly store: Store,
    private readonly pairings: Pairings,
    private readonly self: string,
    private readonly keys: KeyResolver,
  ) {}

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
    const grant = await this.pairings.active();
    const context = grant.body.transcript.body.context;
    if (
      record.source !== 'home' || record.incarnation !== context.id ||
      context.server !== this.self
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'room source does not match home grant',
        403,
      );
    }
    const payload = object(record.payload);
    if (payload.kind !== 'room-replica') {
      throw new LinkError('LINK_BAD_RECORD', 'unknown room operation', 400);
    }
    const manifest = manifestOf(payload.manifest);
    const scope = 'room:' + manifest.roomId;
    if (scope !== stream.stream) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'room scope substitution',
        403,
      );
    }
    const db = await this.store.server();
    const checkGrant = async (conn: import('#engine/store/db.ts').Conn) => {
      const [binding] = await conn.query(
        "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
        [context.id],
      );
      if (
        binding?.state !== 'paired' ||
        Number(binding.revision) !== grant.body.revision
      ) throw new LinkError('LINK_UNPAIRED', 'room grant changed', 403);
    };
    await db.tx(async (conn) => {
      await checkGrant(conn);
      const [prior] = await conn.query(
        'SELECT source_cut,pending_hash FROM facade_scopes WHERE incarnation=? AND scope=?',
        [context.id, scope],
      );
      if (
        (prior ? Number(prior.source_cut) : 0) !== manifest.after ||
        (prior?.pending_hash && prior.pending_hash !== record.hash)
      ) {
        throw new LinkError(
          'LINK_DIVERGED',
          'room suffix does not follow applied source cut',
        );
      }
      await conn.execute(
        'INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,?,?,0,?) ON CONFLICT(incarnation,scope) DO UPDATE SET ready=0,pending_hash=excluded.pending_hash',
        [context.id, scope, manifest.after, record.hash],
      );
    });
    await importReplicaRoom(this.store, manifest, {
      self: this.self,
      keys: this.keys,
    });
    return await journal.apply('home', stream, async (conn, current) => {
      await checkGrant(conn);
      if (current.hash !== record.hash) {
        throw new LinkError('LINK_DIVERGED', 'room application raced');
      }
      const changed = await conn.execute(
        'UPDATE facade_scopes SET source_cut=?,ready=1,pending_hash=NULL WHERE incarnation=? AND scope=? AND source_cut=? AND pending_hash=?',
        [manifest.cut, context.id, scope, manifest.after, record.hash],
      );
      if (changed !== 1) {
        throw new LinkError(
          'LINK_DIVERGED',
          'room completion lost its pending identity',
        );
      }
      return { roomId: manifest.roomId, cut: manifest.cut };
    });
  }
}
