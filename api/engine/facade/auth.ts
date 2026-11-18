// Facade admission composes grant, applied account cut and link health before
// the tenant transaction; only the tenant owner may confirm/mint session state.
import { canonicalJson } from '#engine/canonical.ts';
import type { Database } from '#engine/store/db.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import {
  accountAuthPublication,
  authUnavailable,
  requireAccountAuth,
} from '#engine/tenant/account-auth.ts';
import type { PreparedIngressAuthority } from '#engine/tenant/ingress.ts';
import { requireSessionAuthority } from '#engine/tenant/session-authority.ts';
import { localpartOf } from '#engine/tenant/auth.ts';
import { DirectoryReplicas } from './directory.ts';
import type { NodeIdentity } from './identity.ts';
import { receivedFence } from './journal.ts';
import { noticeHeads } from './notices.ts';
import type { Pairings } from './pairing.ts';
import { type Cut, LinkError } from './protocol.ts';

export class AuthLinkHealth {
  private readonly connections = new Map<
    AbortSignal,
    { pairing: string; heads: Map<string, Cut> }
  >();
  private readonly declarations = new Map<
    string,
    Map<string, { at: number; head: Cut }>
  >();

  constructor(
    private readonly settings: { notify: string; pollseconds: number },
  ) {}

  connected(pairing: string, signal: AbortSignal): void {
    if (signal.aborted || this.connections.has(signal)) return;
    this.connections.set(signal, { pairing, heads: new Map() });
    signal.addEventListener('abort', () => this.connections.delete(signal), {
      once: true,
    });
  }

  observe(pairing: string, raw: unknown, now = Date.now()): void {
    this.reconciliation()(pairing, raw, now);
  }

  /** Capture before the request's first await. Delayed pages may raise the
   * required cut, but cannot certify a connection opened after they arrived. */
  reconciliation(): (pairing: string, raw: unknown, now?: number) => void {
    const connections = [...this.connections];
    return (pairing, raw, now = Date.now()) => {
      this.observeHeads(pairing, raw, now, connections);
    };
  }

  private observeHeads(
    pairing: string,
    raw: unknown,
    now: number,
    connections: Array<[
      AbortSignal,
      { pairing: string; heads: Map<string, Cut> },
    ]>,
  ): void {
    const heads = new Map<string, Cut>();
    for (const entry of noticeHeads(raw)) {
      if (
        entry.source !== 'home' || entry.incarnation !== pairing ||
        heads.has(entry.stream)
      ) {
        throw new LinkError(
          'LINK_IDENTITY_MISMATCH',
          'invalid home reconciliation heads',
          403,
        );
      }
      heads.set(entry.stream, entry.head);
    }
    // Concurrent pages can arrive out of order. Older captures never
    // lower the already observed required cut or hide a newly declared stream.
    const prior = this.declarations.get(pairing) ??
      new Map<string, { at: number; head: Cut }>();
    for (const [scope, next] of heads) {
      const held = prior.get(scope)?.head;
      if (held && next.sequence === held.sequence && next.hash !== held.hash) {
        throw new LinkError(
          'LINK_DIVERGED',
          'home reconciliation head changed',
        );
      }
    }
    for (const [scope, next] of heads) {
      if (!scope.startsWith('auth:')) continue;
      const held = prior.get(scope)?.head;
      if (!held || next.sequence >= held.sequence) {
        prior.set(scope, { at: now, head: next });
      }
    }
    this.declarations.set(pairing, prior);
    for (const [signal, connection] of connections) {
      if (
        signal.aborted || connection.pairing !== pairing ||
        this.connections.get(signal) !== connection
      ) continue;
      for (const [scope, head] of heads) {
        const held = connection.heads.get(scope);
        if (!held || head.sequence >= held.sequence) {
          connection.heads.set(scope, head);
        }
      }
    }
  }

  ready(
    pairing: string,
    scope: string,
    applied: Cut,
    now = Date.now(),
  ): boolean {
    const declaration = this.declarations.get(pairing)?.get(scope);
    const target = declaration?.head;
    if (
      !declaration || !target || target.sequence === 0 ||
      applied.sequence < target.sequence ||
      (applied.sequence === target.sequence && applied.hash !== target.hash)
    ) return false;
    // Poll has no live connection to observe closing. Its existing configured
    // cadence bounds the observation; no independent auth timeout is invented.
    return this.settings.notify === 'poll'
      ? now >= declaration.at &&
        now - declaration.at <= this.settings.pollseconds * 1000
      : [...this.connections].some(([signal, connection]) => {
        const observed = connection.heads.get(scope);
        return connection.pairing === pairing && !signal.aborted &&
          observed?.sequence === target.sequence &&
          observed.hash === target.hash;
      });
  }
}

export class FacadeAuth {
  constructor(
    private readonly server: Database,
    private readonly pairings: Pairings,
    private readonly node: NodeIdentity,
    private readonly health: AuthLinkHealth,
    private readonly settings: {
      replicatecredentials: boolean;
      allowstaleauth: boolean;
      authmaxstalehours: number;
    },
  ) {}

  async prepare(): Promise<PreparedIngressAuthority> {
    // Passive replication reads still work before activation. Explicit auth or
    // user-domain intents consume admission; unknown tokens keep their normal401.
    const received = receivedFence(this.server);
    const admission = await this.capture().catch(() => null);
    const prepared: PreparedIngressAuthority = {
      check: async (conn, intent) => {
        const unavailable: () => never = () => {
          if (intent.kind !== 'domain' && intent.kind !== 'openid') {
            return authUnavailable();
          }
          throw new MatrixError(
            503,
            'M_UNAVAILABLE',
            'domain snapshot unavailable',
          );
        };
        if (intent.kind === 'openid') {
          if (!admission) unavailable();
          const held = await conn.query(
            'SELECT localpart FROM openid_tokens WHERE token_hash=?',
            [intent.hash],
          );
          // A missing legacy digest is known absent only after the selected
          // inventories are complete. The bearer is never a client session.
          const inventoryCurrent = () =>
            received('home', {
              source: 'home',
              incarnation: admission.pairing,
              stream: 'directory',
            });
          if (!held.length && (!admission.inventory || !inventoryCurrent())) {
            unavailable();
          }
          const accounts = held.length
            ? held
            : admission.inventory!.users.map((user) => ({
              localpart: localpartOf(user),
            }));
          for (const account of accounts) {
            await prepared.check(conn, {
              kind: 'domain',
              localpart: String(account.localpart),
              feature: 'openid',
            });
          }
          if (!held.length && !inventoryCurrent()) unavailable();
          return;
        }
        let localpart: string;
        if (intent.kind === 'session') {
          await requireSessionAuthority(conn, intent.hash, intent.refresh);
          const [session] = await conn.query(
            'SELECT localpart FROM session_authority WHERE hash=? AND refresh=?',
            [intent.hash, intent.refresh ? 1 : 0],
          );
          if (!session) {
            const [unbound] = await conn.query(
              `SELECT localpart FROM ${
                intent.refresh ? 'refresh_tokens' : 'access_tokens'
              } WHERE token=?`,
              [intent.hash],
            );
            if (unbound) authUnavailable();
            return;
          }
          localpart = String(session.localpart);
        } else localpart = intent.localpart;
        if (
          !admission ||
          (intent.kind === 'password' && !this.settings.replicatecredentials)
        ) unavailable();
        const scope = (intent.kind === 'domain' ? 'domain:@' : 'auth:@') +
          localpart + ':' + this.node.server;
        const cut = admission.scopes.find((row) => row.scope === scope);
        const current = () =>
          received('home', {
            source: 'home',
            incarnation: admission.pairing,
            stream: scope,
          });
        // Auth may use a complete older cut in permissive mode. Domain reads
        // require complete bootstrap and applied received facts, not a partial
        // value that masquerades as absence or a completed whole register.
        if (
          !cut ||
          (intent.kind === 'domain'
            ? !current() || cut.ready !== 1 || cut.pending_hash !== null ||
              Number(cut.source_cut) < 1 ||
              Number(cut.received) !== Number(cut.applied) ||
              cut.received_hash !== cut.applied_hash ||
              (intent.feature === 'filters' && cut.filters_ready !== 1) ||
              (intent.feature === 'openid' && cut.openid_ready !== 1)
            : cut.ready !== 1 && cut.pending_hash === null)
        ) {
          unavailable();
        }
        const [activation] = await conn.query(
          'SELECT a.revision,c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
          [admission.pairing],
        );
        if (
          !activation || activation.revision !== admission.control.revision ||
          activation.signed_json !== admission.control.signed_json
        ) unavailable();
        if (intent.kind === 'domain') {
          // Bootstrap completeness is independent of password replication and
          // link freshness. Recheck its account/control binding in this file.
          const [selected] = await conn.query(
            'SELECT pairing,grant_revision,owner_revision FROM account_auth_snapshots WHERE localpart=?',
            [localpart],
          );
          if (
            selected?.pairing !== admission.pairing ||
            Number(selected.grant_revision) !== admission.grantRevision ||
            Number(selected.owner_revision) !== Number(activation.revision) ||
            !current()
          ) unavailable();
          return;
        }
        const binding = {
          pairing: admission.pairing,
          grantRevision: admission.grantRevision,
          ownerRevision: Number(activation.revision),
        };
        // Read the publication and installed cut from this same owner commit.
        // The asynchronously projected server scope must not select a different
        // tenant snapshot for permissive authentication.
        const publication = await accountAuthPublication(
          conn,
          localpart,
          binding,
        );
        await requireAccountAuth(
          conn,
          localpart,
          {
            ...binding,
            sourceCut: publication.sourceCut,
          },
          this.settings,
          current() && cut.ready === 1 && cut.pending_hash === null &&
            Number(cut.source_cut) === publication.sourceCut &&
            Number(cut.applied) === publication.sequence &&
            cut.applied_hash === publication.hash &&
            Number(cut.received) === Number(cut.applied) &&
            cut.received_hash === cut.applied_hash &&
            this.health.ready(admission.pairing, scope, {
              sequence: Number(cut.applied),
              hash: String(cut.applied_hash),
            }),
          intent.kind === 'password',
        );
      },
    };
    return prepared;
  }

  private async capture() {
    const grant = await this.pairings.active();
    const pairing = grant.body.transcript.body.context.id;
    // The directory owner proves the complete selected user set. Imported auth
    // rows alone cannot prove absence: another user's private stream may lag.
    // Missing inventory affects only OpenID absence, not independent auth work.
    const inventory = await new DirectoryReplicas(
      this.server,
      this.pairings,
      this.node.server,
    )
      .snapshot().catch(() => null);
    return await this.server.tx(async (conn) => {
      const [binding] = await conn.query(
        "SELECT state,grant_json FROM facade_pairings WHERE id=? AND side='facade'",
        [pairing],
      );
      if (
        binding?.state !== 'paired' ||
        binding.grant_json !== canonicalJson(grant)
      ) authUnavailable();
      const [control] = await conn.query(
        'SELECT a.revision,c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
        [pairing],
      );
      if (!control) authUnavailable();
      const body = JSON.parse(String(control.signed_json)).body;
      if (
        body.grantRevision !== grant.body.revision ||
        body.nodes[1].node !== this.node.node ||
        body.nodes[1].incarnation !== this.node.incarnation
      ) authUnavailable();
      const scopes = await conn.query(
        "SELECT s.scope,s.source_cut,s.ready,s.pending_hash,j.received,j.received_hash,j.applied,j.applied_hash,EXISTS(SELECT 1 FROM facade_scopes f WHERE f.incarnation=s.incarnation AND f.scope='filters:'||substr(s.scope,8) AND f.ready=1) AS filters_ready,EXISTS(SELECT 1 FROM facade_scopes o WHERE o.incarnation=s.incarnation AND o.scope='openid:'||substr(s.scope,8) AND o.ready=1) AS openid_ready FROM facade_scopes s JOIN facade_streams j ON j.incarnation=s.incarnation AND j.stream=s.scope AND j.peer='home' AND j.direction='in' AND j.source='home' WHERE s.incarnation=? AND (s.scope LIKE 'auth:%' OR s.scope LIKE 'domain:%')",
        [pairing],
      );
      return {
        pairing,
        grantRevision: grant.body.revision,
        control,
        scopes,
        inventory,
      };
    });
  }
}
