// Facade admission composes grant, applied account cut and link health before
// the tenant transaction; only the tenant owner may confirm/mint session state.
import { canonicalJson } from '#engine/canonical.ts';
import type { Database } from '#engine/store/db.ts';
import {
  authUnavailable,
  requireAccountAuth,
} from '#engine/tenant/account-auth.ts';
import type { PreparedIngressAuthority } from '#engine/tenant/ingress.ts';
import { requireSessionAuthority } from '#engine/tenant/session-authority.ts';
import type { NodeIdentity } from './identity.ts';
import { noticeHeads } from './notices.ts';
import type { Pairings } from './pairing.ts';
import { type Cut, LinkError } from './protocol.ts';

export class AuthLinkHealth {
  private readonly connections = new Map<AbortSignal, string>();
  private readonly declarations = new Map<
    string,
    Map<string, { at: number; head: Cut }>
  >();

  constructor(
    private readonly settings: { notify: string; pollseconds: number },
  ) {}

  connected(pairing: string, signal: AbortSignal): void {
    if (signal.aborted) return;
    this.connections.set(signal, pairing);
    signal.addEventListener('abort', () => this.connections.delete(signal), {
      once: true,
    });
  }

  observe(pairing: string, raw: unknown, now = Date.now()): void {
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
      : [...this.connections].some(([signal, id]) =>
        id === pairing && !signal.aborted
      );
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
    // Passive tenant reads still work before activation. Only an actual auth
    // intent consumes this admission, and unknown tokens keep their normal401.
    const admission = await this.capture().catch(() => null);
    return {
      check: async (conn, intent) => {
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
        ) authUnavailable();
        const scope = 'auth:@' + localpart + ':' + this.node.server;
        const cut = admission.scopes.find((row) => row.scope === scope);
        // A pending successor does not revoke a still-complete held cut in
        // permissive mode. Exact tenant/source equality below excludes the
        // mixed-file interval after install and before its durable completion.
        if (!cut || (cut.ready !== 1 && cut.pending_hash === null)) {
          authUnavailable();
        }
        const [activation] = await conn.query(
          'SELECT a.revision,c.signed_json FROM facade_owner_activation a JOIN facade_owner_controls c ON c.pairing=a.pairing AND c.revision=a.revision WHERE a.pairing=?',
          [admission.pairing],
        );
        if (
          !activation || activation.revision !== admission.control.revision ||
          activation.signed_json !== admission.control.signed_json
        ) authUnavailable();
        await requireAccountAuth(
          conn,
          localpart,
          {
            pairing: admission.pairing,
            grantRevision: admission.grantRevision,
            ownerRevision: Number(activation.revision),
            sourceCut: Number(cut.source_cut),
          },
          this.settings,
          cut.ready === 1 && cut.pending_hash === null &&
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
  }

  private async capture() {
    const grant = await this.pairings.active();
    const pairing = grant.body.transcript.body.context.id;
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
        "SELECT s.scope,s.source_cut,s.ready,s.pending_hash,j.received,j.received_hash,j.applied,j.applied_hash FROM facade_scopes s JOIN facade_streams j ON j.incarnation=s.incarnation AND j.stream=s.scope AND j.peer='home' AND j.direction='in' AND j.source='home' WHERE s.incarnation=? AND s.scope LIKE 'auth:%'",
        [pairing],
      );
      return { pairing, grantRevision: grant.body.revision, control, scopes };
    });
  }
}
