// Per-user public replication shares the room owner's cross-file completion
// contract; private tenant state never enters these records.
import type { Store } from '#engine/store/index.ts';
import type { Tenant } from '#engine/tenant/index.ts';
import { publicUserOf } from '#engine/tenant/public-replica.ts';
import { appendRecord, type Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
import {
  integer,
  LinkError,
  type LinkRecord,
  object,
  type Stream,
} from './protocol.ts';
import { applyReplicaScope } from './scopes.ts';

export async function exportPublicReplica(
  store: Store,
  tenant: Tenant,
  localpart: string,
  peer: string,
  pairing: string,
): Promise<LinkRecord | null> {
  const db = await store.server();
  const scope = 'public:@' + localpart + ':' + tenant.serverName;
  for (;;) {
    const [prior] = await db.query(
      'SELECT source_cut FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
      [peer, pairing, scope],
    );
    const after = prior ? Number(prior.source_cut) : 0;
    const view = await tenant.tx((tx) =>
      tx.publicReplica.export(localpart, tenant.serverName)
    );
    if (prior && view.cut === after) return null;
    if (view.cut < after) {
      throw new LinkError('LINK_DIVERGED', 'public source cut regressed');
    }
    const record = await db.tx(async (conn) => {
      const [binding] = await conn.query(
        "SELECT node,state FROM facade_pairings WHERE id=? AND side='home'",
        [pairing],
      );
      if (binding?.node !== peer || binding.state !== 'paired') {
        throw new LinkError(
          'LINK_UNPAIRED',
          'public export requires active pairing',
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
        type: 'public-replica',
        version: 1,
        operationId: `public:${pairing}:${view.userId}:${view.cut}`,
        payload: { kind: 'public-replica', after, view },
      });
      await conn.execute(
        'INSERT INTO facade_exports(peer,incarnation,scope,source_cut) VALUES(?,?,?,?) ON CONFLICT(peer,incarnation,scope) DO UPDATE SET source_cut=excluded.source_cut',
        [peer, pairing, scope, view.cut],
      );
      return record;
    });
    if (record) return record;
  }
}

export class PublicReplicas {
  constructor(
    private readonly store: Store,
    private readonly tenant: Tenant,
    private readonly pairings: Pairings,
  ) {}

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    if (record.type !== 'public-replica' || record.version !== 1) {
      throw new LinkError('LINK_CAPABILITY_MISMATCH', 'not a public replica');
    }
    const payload = object(record.payload);
    if (payload.kind !== 'public-replica') {
      throw new LinkError('LINK_BAD_RECORD', 'unknown public operation', 400);
    }
    const view = publicUserOf(payload.view, this.tenant.serverName);
    const after = integer(payload.after);
    if (view.cut < after) {
      throw new LinkError('LINK_DIVERGED', 'public source cut regressed');
    }
    return await applyReplicaScope({
      db: await this.store.server(),
      pairings: this.pairings,
      self: this.tenant.serverName,
      journal,
      stream,
      record,
      scope: 'public:' + view.userId,
      after,
      cut: view.cut,
      apply: async () => {
        await this.tenant.tx((tx) =>
          tx.publicReplica.install(view, this.tenant.serverName)
        );
        return { userId: view.userId, cut: view.cut };
      },
    });
  }
}

export function startPublicExports(
  options: {
    store: Store;
    tenant: Tenant;
    peer: string;
    pairing: string;
    changed(): void;
    failed(error: unknown, user?: string): void;
  },
) {
  let stopped = false;
  let scanning: Promise<void> | undefined;
  const running = new Map<string, Promise<void>>();
  const wake = () => {
    if (stopped) return;
    scanning ??= (async () => {
      try {
        const users = await options.tenant.tx((tx) => tx.publicReplica.users());
        for (const user of users) {
          if (stopped || running.has(user)) continue;
          const work = exportPublicReplica(
            options.store,
            options.tenant,
            user,
            options.peer,
            options.pairing,
          )
            .then((record) => {
              if (record) options.changed();
            })
            .catch((error) => options.failed(error, user));
          running.set(user, work);
          void work.finally(() => running.delete(user));
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
