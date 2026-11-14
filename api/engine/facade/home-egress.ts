// Home proposes exact frozen bytes through its initiated link. A retained
// dispatch/result loss can only retry that envelope, never select a new owner.
import { canonicalJson } from '#engine/canonical.ts';
import { sendVerdicts } from '#engine/federation/responses.ts';
import type { Database } from '#engine/store/db.ts';
import type { EgressEnvelope } from './egress.ts';
import type { Dispatch } from '#engine/server/delivery.ts';
import type { Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
import { LinkError, object, text } from './protocol.ts';

function pending(): never {
  throw new LinkError(
    'LINK_UNAVAILABLE',
    'egress awaits its destination owner',
    503,
  );
}
function responseOf(raw: unknown) {
  return { pdus: sendVerdicts(raw) };
}

export class HomeEgress {
  constructor(
    private readonly db: Database,
    private readonly pairings: Pairings,
    private readonly journal: Journal,
    private readonly nodes: readonly string[],
    private readonly mode: EgressEnvelope['mode'],
    private readonly direct: Dispatch,
    private readonly changed: (peer: string) => void,
  ) {}

  private async route(destination: string) {
    let held = (await this.db.query(
      'SELECT peer,pairing FROM facade_egress_routes WHERE destination=?',
      [destination],
    ))[0];
    if (!held) {
      const node = this.nodes[0];
      const peers = await this.pairings.status();
      const selected = peers.find((peer) =>
        peer.node === node && peer.state === 'paired'
      );
      if (!selected) pending();
      held = await this.db.tx(async (conn) => {
        await conn.execute(
          'INSERT INTO facade_egress_routes(destination,peer,pairing) VALUES(?,?,?) ON CONFLICT DO NOTHING',
          [destination, node, selected.id],
        );
        return (await conn.query(
          'SELECT peer,pairing FROM facade_egress_routes WHERE destination=?',
          [destination],
        ))[0];
      });
    }
    const peer = text(held.peer), pairing = text(held.pairing);
    const binding = await this.pairings.connection(pairing);
    if (
      !this.nodes.includes(peer) || binding.context.node !== peer ||
      binding.state !== 'paired' || !binding.grant
    ) pending();
    return { peer, pairing };
  }

  async dispatch(candidate: Parameters<Dispatch>[0]): Promise<unknown> {
    const { peer, pairing } = await this.route(candidate.destination);
    const stream = {
      source: 'home',
      incarnation: pairing,
      stream: 'egress:' + candidate.destination,
    };
    const identity = canonicalJson([candidate.destination, candidate.txnId]);
    const proposalId = 'egress:propose:' + identity;
    const prior = await this.journal.outgoing(peer, stream, proposalId);
    const savedProposal = prior ? object(prior.record.payload) : null;
    const mode = savedProposal ? savedProposal.mode : this.mode;
    if (mode !== 'direct' && mode !== 'facade') {
      throw new LinkError('LINK_DIVERGED', 'invalid retained egress mode');
    }
    const envelope: EgressEnvelope = { ...candidate, mode };
    if (
      savedProposal &&
      (savedProposal.destination !== candidate.destination ||
        savedProposal.txnId !== candidate.txnId ||
        savedProposal.body !== candidate.body ||
        savedProposal.kind !== 'propose')
    ) {
      throw new LinkError('LINK_DIVERGED', 'changed home egress candidate');
    }
    const proposal = await this.journal.append(peer, {
      ...stream,
      type: 'egress',
      version: 1,
      operationId: proposalId,
      payload: { kind: 'propose', ...envelope },
    });
    this.changed(peer);
    const accepted = await this.journal.result(peer, 'out', proposal, proposal);
    if (!accepted) pending();
    const grant = object(accepted.result);
    const fence = text(grant.fence);
    if (grant.response !== null) return responseOf(grant.response);
    if (envelope.mode !== 'direct') {
      throw new LinkError(
        'LINK_DIVERGED',
        'facade dispatch has no completed response',
      );
    }
    const completionId = 'egress:complete:' + identity;
    let completed = await this.journal.outgoing(peer, stream, completionId);
    if (!completed) {
      const response = responseOf(await this.direct(candidate));
      const record = await this.journal.append(peer, {
        ...stream,
        type: 'egress',
        version: 1,
        operationId: completionId,
        payload: { kind: 'complete', ...envelope, fence, response },
      });
      completed = { record, result: null };
      this.changed(peer);
    }
    const saved = object(completed.record.payload);
    if (
      saved.fence !== fence || saved.body !== candidate.body ||
      saved.txnId !== candidate.txnId ||
      saved.destination !== candidate.destination
    ) {
      throw new LinkError('LINK_DIVERGED', 'changed home egress completion');
    }
    const ack = await this.journal.result(
      peer,
      'out',
      completed.record,
      completed.record,
    );
    if (!ack) pending();
    const result = object(ack.result);
    if (
      result.fence !== fence ||
      canonicalJson(responseOf(result.response)) !==
        canonicalJson(responseOf(saved.response))
    ) {
      throw new LinkError('LINK_DIVERGED', 'changed owner egress result');
    }
    return responseOf(result.response);
  }
}
