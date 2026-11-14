// Full semantic directory cuts and scope inventory. All source server facts,
// the immutable record and its export watermark commit together. Independent
// room/user streams need not be ready before this manifest can describe them.
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import {
  exportPeerPolicy,
  installPeerPolicy,
  type PeerPolicy,
  peerPolicyOf,
} from '#engine/federation/policy-replica.ts';
import { splitId } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  type DirectoryFacts,
  directoryFactsOf,
  exportDirectoryFacts,
  installDirectoryFacts,
  publishedRoomScopes,
} from '#engine/server/public-replica.ts';
import type { Database } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
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

export type DirectoryReplica = {
  server: string;
  rooms: string[];
  users: string[];
  cuts: Record<string, number>;
  directory: DirectoryFacts;
  policy: PeerPolicy;
  publicRooms: boolean;
};
function manifestOf(raw: unknown, self: string): DirectoryReplica {
  const v = object(raw);
  if (
    v.server !== self || !Array.isArray(v.rooms) || !Array.isArray(v.users) ||
    typeof v.publicRooms !== 'boolean'
  ) {
    throw new LinkError('LINK_BAD_RECORD', 'invalid directory manifest', 400);
  }
  const ids = (raw: unknown[], sigil: string) => {
    const values = raw.map(text);
    if (
      values.some((id) =>
        !id.startsWith(sigil) || !splitId(id).localpart ||
        !splitId(id).server || (sigil === '@' && splitId(id).server !== self)
      ) || new Set(values).size !== values.length
    ) {
      throw new LinkError('LINK_BAD_RECORD', 'invalid scope inventory', 400);
    }
    return values;
  };
  const rooms = ids(v.rooms, '!'), users = ids(v.users, '@');
  const cuts = object(v.cuts);
  const scopes = [
    ...rooms.map((id) => 'room:' + id),
    ...users.map((id) => 'public:' + id),
  ];
  if (
    Object.keys(cuts).length !== scopes.length ||
    scopes.some((scope) => !Object.hasOwn(cuts, scope))
  ) {
    throw new LinkError(
      'LINK_BAD_RECORD',
      'scope cuts do not match inventory',
      400,
    );
  }
  return {
    server: self,
    rooms,
    users,
    cuts: Object.fromEntries(
      scopes.map((scope) => [scope, integer(cuts[scope])]),
    ),
    directory: directoryFactsOf(v.directory, self),
    policy: peerPolicyOf(v.policy),
    publicRooms: v.publicRooms,
  };
}

export async function exportDirectoryReplica(
  store: Store,
  tenant: Tenant,
  peer: string,
  pairing: string,
): Promise<LinkRecord | null> {
  const users = await tenant.tx((tx) => tx.publicReplica.inventory());
  const userIds = users.users.map((user) =>
    '@' + user + ':' + tenant.serverName
  );
  const db = await store.server();
  return await db.tx(async (conn) => {
    const rooms = await publishedRoomScopes(conn);
    const [binding] = await conn.query(
      "SELECT node,state FROM facade_pairings WHERE id=? AND side='home'",
      [pairing],
    );
    if (binding?.node !== peer || binding.state !== 'paired') {
      throw new LinkError(
        'LINK_UNPAIRED',
        'directory export requires active pairing',
        403,
      );
    }
    const view: DirectoryReplica = {
      server: tenant.serverName,
      rooms: rooms.map((room) => room.id),
      users: userIds,
      cuts: Object.fromEntries([
        ...rooms.map((room) => ['room:' + room.id, room.cut]),
        ...userIds.map((user) => ['public:' + user, users.cut]),
      ]),
      directory: await exportDirectoryFacts(conn, tenant.serverName),
      policy: await exportPeerPolicy(conn),
      publicRooms: config().federation.publicrooms,
    };
    const [prior] = await conn.query(
      "SELECT record_json FROM facade_records WHERE peer=? AND direction='out' AND source='home' AND incarnation=? AND stream='directory' ORDER BY sequence DESC LIMIT 1",
      [peer, pairing],
    );
    const previous = prior
      ? JSON.parse(String(prior.record_json)).payload
      : null;
    if (previous && canonicalJson(previous.view) === canonicalJson(view)) {
      return null;
    }
    const after = previous ? integer(previous.cut) : 0;
    const cut = after + 1;
    const record = await appendRecord(conn, peer, {
      source: 'home',
      incarnation: pairing,
      stream: 'directory',
      type: 'directory-replica',
      version: 1,
      operationId: `directory:${pairing}:${cut}`,
      payload: { kind: 'directory-replica', after, cut, view },
    });
    await conn.execute(
      'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
      [peer, pairing, 'directory', cut],
    );
    return record;
  });
}

export function startDirectoryExports(
  options: {
    store: Store;
    tenant: Tenant;
    peer: string;
    pairing: string;
    changed(): void;
    failed(error: unknown): void;
  },
) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let closed: Promise<void> | undefined;
  return {
    wake() {
      if (stopped || running) return;
      running = exportDirectoryReplica(
        options.store,
        options.tenant,
        options.peer,
        options.pairing,
      )
        .then((record) => {
          if (record) options.changed();
        })
        .catch(options.failed)
        .finally(() => {
          running = undefined;
        });
    },
    close: () =>
      closed ??= (async () => {
        stopped = true;
        await running;
      })(),
  };
}

export class DirectoryReplicas {
  constructor(
    private readonly db: Database,
    private readonly pairings: Pairings,
    private readonly self: string,
  ) {}

  async snapshot(): Promise<DirectoryReplica | null> {
    const context = (await this.pairings.active()).body.transcript.body.context;
    const [row] = await this.db.query(
      "SELECT r.record_json FROM facade_streams s JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream AND v.ready=1 WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream='directory' AND s.received=s.applied",
      [context.id],
    );
    return row
      ? manifestOf(JSON.parse(String(row.record_json)).payload.view, this.self)
      : null;
  }

  async requireScope(scope: string): Promise<void> {
    const view = await this.snapshot();
    const unavailable = () => {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
    };
    if (!view) unavailable();
    if (scope === 'directory') return;
    const grant = await this.pairings.active();
    const [held] = await this.db.query(
      "SELECT s.received,s.applied,v.source_cut,v.ready FROM facade_streams s LEFT JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream=?",
      [grant.body.transcript.body.context.id, scope],
    );
    const required = view!.cuts[scope];
    // A newer stream may precede the next inventory. Do not hide that held scope.
    if (
      held && Number(held.ready) === 1 &&
      Number(held.received) === Number(held.applied) &&
      Number(held.source_cut) >= (required ?? 0)
    ) return;
    if (required !== undefined || held) unavailable();
    throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (record.type !== 'directory-replica' || record.version !== 1) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'not a directory replica',
      );
    }
    const payload = object(record.payload);
    if (payload.kind !== 'directory-replica') {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'invalid directory operation',
        400,
      );
    }
    const view = manifestOf(payload.view, this.self);
    const after = integer(payload.after), cut = integer(payload.cut, 1);
    if (cut !== after + 1) {
      throw new LinkError('LINK_DIVERGED', 'invalid directory source cut');
    }
    const grant = await this.pairings.active();
    const context = grant.body.transcript.body.context;
    if (
      record.source !== 'home' || record.incarnation !== context.id ||
      context.server !== this.self || stream.stream !== 'directory'
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'directory source does not match grant',
        403,
      );
    }
    return await journal.apply('home', stream, async (conn, current) => {
      const [binding] = await conn.query(
        "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
        [context.id],
      );
      if (
        binding?.state !== 'paired' ||
        Number(binding.revision) !== grant.body.revision
      ) throw new LinkError('LINK_UNPAIRED', 'directory grant changed', 403);
      const [prior] = await conn.query(
        "SELECT source_cut FROM facade_scopes WHERE incarnation=? AND scope='directory'",
        [context.id],
      );
      if (
        (prior ? Number(prior.source_cut) : 0) !== after ||
        current.hash !== record.hash
      ) throw new LinkError('LINK_DIVERGED', 'directory source cut diverged');
      await installDirectoryFacts(conn, view.directory, this.self);
      await installPeerPolicy(conn, view.policy);
      await conn.execute(
        "INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,'directory',?,1,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=1,pending_hash=NULL",
        [context.id, cut],
      );
      return { cut };
    });
  }
}
