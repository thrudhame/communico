// Full semantic directory cuts and scope inventory. All source server facts,
// the immutable record and its export watermark commit together. Independent
// room/user streams need not be ready before this manifest can describe them.
import { canonicalJson } from '#engine/canonical.ts';
import { config } from '#engine/config.ts';
import { reconcileKeyDecisions } from '#engine/federation/keys.ts';
import {
  exportPeerPolicy,
  installPeerPolicy,
  type PeerPolicy,
  peerPolicyOf,
} from '#engine/federation/policy-replica.ts';
import { splitId } from '#engine/ids.ts';
import { validRoomId } from '#engine/room/identity.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { rankedDirectoryPageAt } from '#engine/server/directory-rank.ts';
import {
  type DirectoryFacts,
  directoryFactsOf,
  exportDirectoryFacts,
  installDirectoryFacts,
  publishedRoomScopes,
} from '#engine/server/public-replica.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import type { Store } from '#engine/store/index.ts';
import { onProjected } from '#engine/server/project.ts';
import { onTenantStream } from '#engine/tenant/streams.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { appendRecord, type Journal, receivedFence } from './journal.ts';
import type { Pairings } from './pairing.ts';
import { membershipExportPrefix } from './membership.ts';
import {
  type ObserveCut,
  ReplicaCutPending,
  type ReplicaReadiness,
} from './readiness.ts';
import { signingFence } from './signing-authority.ts';
import { type CommitCheck, commitCheck } from '#engine/store/commit.ts';
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
function manifestOf(
  raw: unknown,
  self: string,
  version: number,
): DirectoryReplica {
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
        sigil === '!'
          ? !validRoomId(id)
          : !id.startsWith(sigil) || !splitId(id).localpart ||
            splitId(id).server !== self
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
    ...(version === 2 ? users.map((id) => 'membership:' + id) : []),
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
  version: 1 | 2 = 1,
): Promise<LinkRecord | null> {
  const users = await tenant.tx((tx) => tx.publicReplica.inventory());
  const userIds = users.users.map((user) =>
    '@' + user + ':' + tenant.serverName
  );
  const db = await store.server();
  return await db.tx(async (conn) => {
    const rooms = await publishedRoomScopes(conn);
    const [binding] = await conn.query(
      "SELECT node,state,grant_json FROM facade_pairings WHERE id=? AND side='home'",
      [pairing],
    );
    if (binding?.node !== peer || binding.state !== 'paired') {
      throw new LinkError(
        'LINK_UNPAIRED',
        'directory export requires active pairing',
        403,
      );
    }
    const membership: [string, number][] = [];
    if (version === 2) {
      if (!binding.grant_json) {
        throw new LinkError(
          'LINK_UNPAIRED',
          'directory requires current grant',
          403,
        );
      }
      const grant = JSON.parse(String(binding.grant_json));
      for (const user of users.users) {
        membership.push([
          'membership:@' + user + ':' + tenant.serverName,
          await membershipExportPrefix(conn, grant, user),
        ]);
      }
    }
    const view: DirectoryReplica = {
      server: tenant.serverName,
      rooms: rooms.map((room) => room.id),
      users: userIds,
      cuts: Object.fromEntries([
        ...rooms.map((room) => ['room:' + room.id, room.cut]),
        ...userIds.map((user) => ['public:' + user, users.cut]),
        ...membership,
      ]),
      directory: await exportDirectoryFacts(conn, tenant.serverName),
      policy: await exportPeerPolicy(conn),
      publicRooms: config().federation.publicrooms,
    };
    const [prior] = await conn.query(
      "SELECT record_json FROM facade_records WHERE peer=? AND direction='out' AND source='home' AND incarnation=? AND stream='directory' ORDER BY sequence DESC LIMIT 1",
      [peer, pairing],
    );
    const previousRecord = prior ? JSON.parse(String(prior.record_json)) : null;
    const previous = previousRecord?.payload;
    if (
      previousRecord?.version === version &&
      canonicalJson(previous.view) === canonicalJson(view)
    ) {
      return null;
    }
    const after = previous ? integer(previous.cut) : 0;
    const cut = after + 1;
    const record = await appendRecord(conn, peer, {
      source: 'home',
      incarnation: pairing,
      stream: 'directory',
      type: 'directory-replica',
      version,
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
    version?: 1 | 2;
    changed(): void;
    failed(error: unknown): void;
  },
) {
  let stopped = false;
  let running: Promise<void> | undefined;
  let closed: Promise<void> | undefined;
  let dirty = false;
  const wake = () => {
    if (stopped) return;
    dirty = true;
    running ??= (async () => {
      try {
        do {
          dirty = false;
          try {
            const record = await exportDirectoryReplica(
              options.store,
              options.tenant,
              options.peer,
              options.pairing,
              options.version,
            );
            if (record) options.changed();
          } catch (error) {
            options.failed(error);
          }
        } while (!stopped && dirty);
      } finally {
        running = undefined;
      }
    })();
  };
  const unproject = onProjected((store) => {
    if (store === options.store) wake();
  });
  const untenant = onTenantStream((store, tenant, source) => {
    if (
      source === 'local' && store === options.store &&
      tenant === options.tenant.serverName
    ) wake();
  });
  return {
    wake,
    close: () =>
      closed ??= (async () => {
        stopped = true;
        unproject();
        untenant();
        await running;
      })(),
  };
}

export type ReplicaRoomAdmission = {
  check(conn: Conn): Promise<void>;
  checkCurrent: CommitCheck;
};

// The server retains the authenticated account/control application evidence.
// Public inventory or an arbitrary room file alone is not account selection.
function selectedAccountScope(
  row: Record<string, unknown>,
  pairing: string,
  grantRevision: number,
  self: string,
): boolean {
  if (
    Number(row.ready) !== 1 || row.pending_hash !== null ||
    Number(row.source_cut) < 1 || Number(row.applied) < 1 ||
    row.received !== row.applied || row.received_hash !== row.applied_hash ||
    Number(row.owner_applied) < 1 || row.owner_received !== row.owner_applied ||
    row.owner_received_hash !== row.owner_applied_hash || !row.record_json
  ) return false;
  const record = JSON.parse(String(row.record_json));
  const account = record.payload?.signed?.body;
  return record.type === 'account-auth' && record.version === 1 &&
    account?.pairing === pairing && account.grantRevision === grantRevision &&
    account.ownerRevision === Number(row.owner_revision) &&
    account.sourceCut === Number(row.source_cut) && account.server === self &&
    '@' + account.localpart + ':' + self === row.local_join_user;
}

type ScopeAccess = 'current' | 'applied';

function pendingSuffix(row: Record<string, unknown> | undefined): boolean {
  return !!row && Number(row.received) > Number(row.applied);
}

function pendingAccount(
  row: Record<string, unknown> | undefined,
  pairing: string,
  stream: string,
): ReplicaCutPending | undefined {
  if (pendingSuffix(row)) {
    return new ReplicaCutPending(pairing, stream, false, Number(row!.applied));
  }
  if (row && Number(row.owner_received) > Number(row.owner_applied ?? 0)) {
    return new ReplicaCutPending(
      pairing,
      'owner-control',
      false,
      Number(row.owner_applied ?? 0),
    );
  }
  if (!row || Number(row.applied) === 0) {
    return new ReplicaCutPending(pairing, stream, true);
  }
  if (Number(row.owner_applied ?? 0) === 0) {
    return new ReplicaCutPending(pairing, 'owner-control', true);
  }
}

export class DirectoryReplicas {
  constructor(
    private readonly db: Database,
    private readonly pairings: Pairings,
    private readonly self: string,
    private readonly phase: 'f1' | 'f2' = config().facade.phase as 'f1' | 'f2',
    private readonly readiness?: ReplicaReadiness,
  ) {}

  private async appliedDirectoryAt(conn: Conn, pairing: string) {
    const [row] = await conn.query(
      "SELECT s.received,s.applied,v.ready,p.public_rooms FROM facade_streams s LEFT JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream LEFT JOIN directory_rank_replica p ON p.pairing=s.incarnation AND p.source_cut=v.source_cut WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream='directory'",
      [pairing],
    );
    if (!row || Number(row.applied) === 0) {
      throw new ReplicaCutPending(pairing, 'directory', !pendingSuffix(row));
    }
    if (Number(row.ready) !== 1 || row.public_rooms == null) {
      throw new MatrixError(
        503,
        'M_UNAVAILABLE',
        'directory replica not ready',
      );
    }
    return Number(row.public_rooms) === 1;
  }

  async appliedPublicRooms() {
    const pairing =
      (await this.pairings.active()).body.transcript.body.context.id;
    return await this.db.tx((conn) => this.appliedDirectoryAt(conn, pairing), {
      mode: 'deferred',
    });
  }

  async rankedDirectoryPage(
    offset: number,
    limit: number,
    signal?: AbortSignal,
  ) {
    const read = async () => {
      const grant = await this.pairings.active();
      const pairing = grant.body.transcript.body.context.id;
      return await this.db.tx(async (conn) => {
        await this.appliedDirectoryAt(conn, pairing);
        const page = await rankedDirectoryPageAt(conn, offset, limit);
        for (const room of page.rooms) {
          const scope = 'room:' + room.id;
          const held = await this.heldScopeAt(conn, pairing, scope);
          if (appliedRoomReady(held)) continue;
          // Only a returned row without a completed room cut needs the
          // inventory's required cut or the locally owned scope fallback.
          const { view } = await this.snapshotAt(pairing, 'applied', conn);
          await this.scopeStateAt(
            conn,
            scope,
            pairing,
            grant.body.revision,
            view.cuts[scope],
            'applied',
          );
        }
        return page;
      }, { mode: 'deferred' });
    };
    try {
      // Do not join a wait for newer receives when a completed page is ready.
      return await read();
    } catch (first) {
      if (!(first instanceof ReplicaCutPending) || !signal) throw first;
      return await this.admit(async (observe) => {
        // Observe before re-reading so completion cannot be lost in the
        // interval between deciding to wait and registering the dependency.
        let pending = first;
        const watched = new Set<string>();
        while (true) {
          watched.add(JSON.stringify([pending.pairing, pending.stream]));
          observe?.(pending.pairing, 'directory');
          observe?.(pending.pairing, pending.stream);
          try {
            return await read();
          } catch (next) {
            if (
              !(next instanceof ReplicaCutPending) || !observe ||
              watched.has(JSON.stringify([next.pairing, next.stream]))
            ) throw next;
            pending = next;
          }
        }
      }, signal);
    }
  }

  private async snapshotAt(
    pairing: string,
    access: ScopeAccess,
    db: Pick<Conn, 'query'> = this.db,
  ) {
    const [row] = await db.query(
      "SELECT s.received,s.applied,v.ready,r.record_json FROM facade_streams s LEFT JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied LEFT JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream='directory'",
      [pairing],
    );
    if (access === 'current' && pendingSuffix(row)) {
      throw new ReplicaCutPending(
        pairing,
        'directory',
        false,
        Number(row!.applied),
      );
    }
    if (!row || Number(row.applied) === 0) {
      throw new ReplicaCutPending(pairing, 'directory', !pendingSuffix(row));
    }
    if (Number(row.ready) !== 1 || !row.record_json) {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
    }
    const record = JSON.parse(String(row.record_json));
    return {
      version: Number(record.version),
      view: manifestOf(record.payload.view, this.self, Number(record.version)),
    };
  }

  async snapshot(
    access: ScopeAccess = 'current',
  ): Promise<DirectoryReplica | null> {
    const pairing =
      (await this.pairings.active()).body.transcript.body.context.id;
    try {
      return (await this.snapshotAt(pairing, access)).view;
    } catch (error) {
      if (error instanceof MatrixError && error.status === 503) return null;
      throw error;
    }
  }

  async requireScope(
    scope: string,
    allowAbsent = false,
    signal?: AbortSignal,
  ): Promise<void> {
    if (await this.scopeState(scope, signal) === 'absent' && !allowAbsent) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
    }
  }

  /** Ordinary readers need a completed publication, not the cut advertised by
   * a successor inventory. Their own causal cuts remain completion obligations. */
  async requireReadScope(scope: string, allowAbsent = false): Promise<void> {
    if (
      await this.scopeStateFor(scope, 'applied') === 'absent' && !allowAbsent
    ) {
      throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
    }
  }

  async scopeState(
    scope: string,
    signal?: AbortSignal,
  ): Promise<'ready' | 'absent'> {
    return await this.admit(
      (observe) => this.scopeStateFor(scope, 'current', observe),
      signal,
    );
  }

  /** A pure read can be repeated when the scope changes before its answer. */
  async withCurrentScopes<T>(
    read: (requireScope: (scope: string) => Promise<void>) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    return await this.admit((observe) =>
      read(async (scope) => {
        if (await this.scopeStateFor(scope, 'current', observe) === 'absent') {
          throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
        }
      }), signal);
  }

  private admit<T>(
    read: (observe?: ObserveCut) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return signal && this.readiness
      ? this.readiness.wait(read, signal)
      : read();
  }

  private async scopeStateFor(
    scope: string,
    access: ScopeAccess,
    observe?: ObserveCut,
  ): Promise<'ready' | 'absent'> {
    const grant = await this.pairings.active();
    const pairing = grant.body.transcript.body.context.id;
    observe?.(pairing, 'directory');
    const snapshot = await this.snapshotAt(pairing, access);
    const view = snapshot.view;
    const unavailable = () => {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
    };
    if (scope === 'directory') return 'ready';
    if (scope === 'rooms') {
      if (this.phase === 'f2' && snapshot.version !== 2) unavailable();
      // An ordinary inventory read does not depend on every received room.
      // Its selected audience prepares each actual room dependency separately.
      if (access === 'applied') return 'ready';
      observe?.(pairing, 'rooms');
      const incoming = await this.db.query(
        "SELECT DISTINCT stream FROM facade_streams WHERE peer='home' AND direction='in' AND source='home' AND incarnation=? AND (stream LIKE 'room:%' OR stream LIKE 'membership:%')",
        [pairing],
      );
      const local = await this.db.tx((conn) =>
        this.localScopesAt(conn, pairing)
      );
      for (
        const room of new Set([
          ...view.rooms.map((id) => 'room:' + id),
          ...(this.phase === 'f2'
            ? view.users.map((id) => 'membership:' + id)
            : []),
          ...incoming.map((row) => String(row.stream)).filter((stream) =>
            this.phase === 'f2' || stream.startsWith('room:')
          ),
          ...local.map((row) => 'room:' + String(row.room)),
        ])
      ) {
        if (
          await this.db.tx((conn) =>
            this.scopeStateAt(
              conn,
              room,
              pairing,
              grant.body.revision,
              view.cuts[room],
              access,
              undefined,
              observe,
            )
          ) === 'absent'
        ) {
          throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
        }
      }
      return 'ready';
    }
    return await this.db.tx((conn) =>
      this.scopeStateAt(
        conn,
        scope,
        pairing,
        grant.body.revision,
        view.cuts[scope],
        access,
        undefined,
        observe,
      )
    );
  }

  /** Prepare outside owning transactions. Server writers recheck durable scope
   * state on their connection; tenant writers use the same receive/control
   * fences without opening the server file from a tenant callback. */
  async prepareRoomScope(
    roomId: string,
    allowAbsent = false,
    localUser?: string,
    signal?: AbortSignal,
  ): Promise<ReplicaRoomAdmission> {
    return await this.admit(
      (observe) =>
        this.prepareScope(roomId, allowAbsent, 'current', localUser, observe),
      signal,
    );
  }

  async prepareReadRoomScope(
    roomId: string,
    allowAbsent = false,
  ): Promise<ReplicaRoomAdmission> {
    return await this.prepareScope(roomId, allowAbsent, 'applied');
  }

  private async prepareScope(
    roomId: string,
    allowAbsent: boolean,
    access: ScopeAccess,
    localUser?: string,
    observe?: ObserveCut,
  ): Promise<ReplicaRoomAdmission> {
    const received = receivedFence(this.db), authority = signingFence(this.db);
    const grant = await this.pairings.active();
    const pairing = grant.body.transcript.body.context.id;
    observe?.(pairing, 'directory');
    const snapshot = await this.snapshotAt(pairing, access);
    const view = snapshot.view;
    const unavailable = (): never => {
      throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
    };
    const scope = 'room:' + roomId;
    const localAuth = new Set<string>();
    if (localUser !== undefined) {
      if (!view.users.includes(localUser)) unavailable();
      for (
        const stream of [
          'auth:' + localUser,
          'membership:' + localUser,
          'owner-control',
        ]
      ) {
        localAuth.add(stream);
        observe?.(pairing, stream);
      }
    }
    const checkCurrent = commitCheck(() => {
      authority();
      const streams = access === 'applied'
        ? [...localAuth]
        : ['directory', scope, ...localAuth];
      for (const stream of streams) {
        if (
          !received('home', { source: 'home', incarnation: pairing, stream })
        ) unavailable();
      }
    }, authority);
    const verify = async (conn: Conn, observe?: ObserveCut) => {
      const [binding] = await conn.query(
        "SELECT state,grant_json FROM facade_pairings WHERE id=? AND side='facade'",
        [pairing],
      );
      if (
        binding?.state !== 'paired' ||
        binding.grant_json !== canonicalJson(grant)
      ) unavailable();
      if (localUser !== undefined) {
        const [account] = await conn.query(
          "SELECT ? AS local_join_user,s.stream,s.received,s.received_hash,s.applied,s.applied_hash,v.source_cut,v.ready,v.pending_hash,r.record_json,a.revision AS owner_revision,c.received AS owner_received,c.applied AS owner_applied,c.received_hash AS owner_received_hash,c.applied_hash AS owner_applied_hash FROM facade_streams s LEFT JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream LEFT JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied LEFT JOIN facade_owner_activation a ON a.pairing=s.incarnation LEFT JOIN facade_streams c ON c.peer=s.peer AND c.direction=s.direction AND c.source=s.source AND c.incarnation=s.incarnation AND c.stream='owner-control' WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream=?",
          [localUser, pairing, 'auth:' + localUser],
        );
        if (
          !account ||
          !selectedAccountScope(
            account,
            pairing,
            grant.body.revision,
            this.self,
          )
        ) {
          const pending = pendingAccount(account, pairing, 'auth:' + localUser);
          if (pending) throw pending;
          unavailable();
        }
        const membership = 'membership:' + localUser;
        if (snapshot.version !== 2) unavailable();
        await this.scopeStateAt(
          conn,
          membership,
          pairing,
          grant.body.revision,
          view.cuts[membership],
        );
      }
      const state = await this.scopeStateAt(
        conn,
        scope,
        pairing,
        grant.body.revision,
        view.cuts[scope],
        access,
        localAuth,
        observe,
      );
      if (state === 'absent' && !allowAbsent) {
        throw new MatrixError(404, 'M_NOT_FOUND', 'scope not found');
      }
      conn.admit(checkCurrent);
    };
    await this.db.tx((conn) => verify(conn, observe));
    return { check: (conn) => verify(conn), checkCurrent };
  }

  /** Selection comes from the authenticated account stream, initiation from
   * the room-first projection. A received replica or an arbitrary room file
   * supplies neither a local initiation nor a selected-account grant. */
  private async localScopesAt(conn: Conn, pairing: string, roomId?: string) {
    if (config().facade.phase !== 'f2') return [];
    return await conn.query(
      "SELECT DISTINCT e.room,e.local_join_user,s.stream,s.received,s.received_hash,s.applied,s.applied_hash,v.source_cut,v.ready,v.pending_hash,r.record_json,a.revision AS owner_revision,c.received AS owner_received,c.applied AS owner_applied,c.received_hash AS owner_received_hash,c.applied_hash AS owner_applied_hash FROM event_index e JOIN facade_streams s ON s.stream='auth:'||e.local_join_user AND s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? LEFT JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream LEFT JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied LEFT JOIN facade_owner_activation a ON a.pairing=s.incarnation LEFT JOIN facade_streams c ON c.peer=s.peer AND c.direction=s.direction AND c.source=s.source AND c.incarnation=s.incarnation AND c.stream='owner-control' WHERE e.local_join_user IS NOT NULL AND e.standing='accepted' AND e.grounding='grounded'" +
        (roomId === undefined ? '' : ' AND e.room=?'),
      roomId === undefined ? [pairing] : [pairing, roomId],
    );
  }

  private async heldScopeAt(conn: Conn, pairing: string, scope: string) {
    const [held] = await conn.query(
      "SELECT s.received,s.received_hash,s.applied,s.applied_hash,v.source_cut,v.ready,v.pending_hash FROM facade_streams s LEFT JOIN facade_scopes v ON v.incarnation=s.incarnation AND v.scope=s.stream WHERE s.peer='home' AND s.direction='in' AND s.source='home' AND s.incarnation=? AND s.stream=?",
      [pairing, scope],
    );
    return held;
  }

  private async scopeStateAt(
    conn: Conn,
    scope: string,
    pairing: string,
    grantRevision: number,
    required?: number,
    access: ScopeAccess = 'current',
    localAuth?: Set<string>,
    observe?: ObserveCut,
  ): Promise<'ready' | 'absent'> {
    observe?.(pairing, scope);
    const held = await this.heldScopeAt(conn, pairing, scope);
    if (scope.startsWith('membership:')) {
      // Membership's exact application receipt precedes journal completion; it
      // has no facade_scopes row. An absent stream proves only declared zero.
      if (!held && required === 0) return 'ready';
      if (
        held && Number(held.applied) >= (required ?? 0) &&
        held.received === held.applied &&
        held.received_hash === held.applied_hash
      ) {
        return 'ready';
      }
      if (held || required !== undefined) {
        if (
          pendingSuffix(held) || Number(held?.applied ?? 0) < (required ?? 0)
        ) {
          throw new ReplicaCutPending(
            pairing,
            scope,
            !pendingSuffix(held),
            Number(held?.applied ?? 0),
          );
        }
        throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
      }
      return 'absent';
    }
    // A newer stream may precede the next inventory. Do not hide that held scope.
    // Pending application does not erase the prior completed source cut. Room
    // transactions publish semantic steps through the ordinary completion owner;
    // this does not mark the suffix complete or advance the journal's ACK.
    if (access === 'applied' && appliedRoomReady(held)) return 'ready';
    if (
      held && Number(held.ready) === 1 &&
      Number(held.received) === Number(held.applied) &&
      Number(held.source_cut) >= (required ?? 0)
    ) return 'ready';
    if (required !== undefined || held) {
      if (
        pendingSuffix(held) || Number(held?.source_cut ?? 0) < (required ?? 0)
      ) {
        throw new ReplicaCutPending(
          pairing,
          scope,
          !pendingSuffix(held),
          Number(held?.applied ?? 0),
        );
      }
      throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
    }
    if (scope.startsWith('room:')) {
      const local = await this.localScopesAt(conn, pairing, scope.slice(5));
      if (local.length) observe?.(pairing, 'owner-control');
      for (const row of local) observe?.(pairing, String(row.stream));
      for (const row of local) {
        if (!selectedAccountScope(row, pairing, grantRevision, this.self)) {
          continue;
        }
        localAuth?.add(String(row.stream));
        localAuth?.add('owner-control');
        return 'ready';
      }
      if (local.length) {
        const pending = local.map((row) =>
          pendingAccount(row, pairing, String(row.stream))
        );
        const next = pending.find((cut) => cut && !cut.needsHome) ??
          pending.find((cut) => cut);
        if (next) throw next;
        throw new MatrixError(503, 'M_UNAVAILABLE', 'replica unavailable');
      }
    }
    return 'absent';
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (
      record.type !== 'directory-replica' || ![1, 2].includes(record.version)
    ) {
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
    const view = manifestOf(payload.view, this.self, record.version);
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
    return await reconcileKeyDecisions(
      this.db,
      view.policy.keyDecisions,
      (installKeys) =>
        journal.apply('home', stream, async (conn, current) => {
          const [binding] = await conn.query(
            "SELECT state,revision FROM facade_pairings WHERE id=? AND side='facade'",
            [context.id],
          );
          if (
            binding?.state !== 'paired' ||
            Number(binding.revision) !== grant.body.revision
          ) {
            throw new LinkError(
              'LINK_UNPAIRED',
              'directory grant changed',
              403,
            );
          }
          const [prior] = await conn.query(
            "SELECT source_cut FROM facade_scopes WHERE incarnation=? AND scope='directory'",
            [context.id],
          );
          if (
            (prior ? Number(prior.source_cut) : 0) !== after ||
            current.hash !== record.hash
          ) {
            throw new LinkError(
              'LINK_DIVERGED',
              'directory source cut diverged',
            );
          }
          await installDirectoryFacts(conn, view.directory, this.self);
          await installPeerPolicy(conn, view.policy);
          await installKeys(conn);
          await conn.execute(
            'INSERT INTO directory_rank_replica(pairing,source_cut,public_rooms) VALUES(?,?,?) ON CONFLICT(pairing) DO UPDATE SET source_cut=excluded.source_cut,public_rooms=excluded.public_rooms',
            [context.id, cut, view.publicRooms ? 1 : 0],
          );
          await conn.execute(
            "INSERT INTO facade_scopes(incarnation,scope,source_cut,ready,pending_hash) VALUES(?,'directory',?,1,NULL) ON CONFLICT(incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut,ready=1,pending_hash=NULL",
            [context.id, cut],
          );
          return { cut };
        }),
    );
  }
}

function appliedRoomReady(held: Record<string, unknown> | undefined) {
  return !!held && Number(held.applied) > 0 && Number(held.source_cut) > 0 &&
    (Number(held.ready) === 1 || held.pending_hash !== null);
}
