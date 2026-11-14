// One immutable transaction owns each logical destination until a validated
// response commits. A dispatch grant never expires into a different sender.
import { canonicalJson } from '#engine/canonical.ts';
import { sendVerdicts } from '#engine/federation/responses.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import { type Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
import {
  LinkError,
  type LinkRecord,
  object,
  type Stream,
  text,
} from './protocol.ts';

export const FACADE_EGRESS_SQL = `
CREATE TABLE facade_egress(destination TEXT NOT NULL,txn_id TEXT NOT NULL,body TEXT NOT NULL,mode TEXT NOT NULL,pairing TEXT NOT NULL,fence TEXT NOT NULL,result_json TEXT,PRIMARY KEY(destination,txn_id));
CREATE UNIQUE INDEX facade_egress_active ON facade_egress(destination) WHERE result_json IS NULL;
CREATE TABLE facade_egress_routes(destination TEXT PRIMARY KEY NOT NULL,peer TEXT NOT NULL,pairing TEXT NOT NULL);
`;

export type EgressEnvelope = {
  destination: string;
  txnId: string;
  body: string;
  mode: 'direct' | 'facade';
};
export type Dispatch = (
  envelope: Pick<EgressEnvelope, 'destination' | 'txnId' | 'body'>,
) => Promise<unknown>;

function diverged(message: string): never {
  throw new LinkError('LINK_DIVERGED', message);
}
function envelopeOf(raw: unknown): EgressEnvelope {
  const value = object(raw);
  if (value.mode !== 'direct' && value.mode !== 'facade') {
    diverged('invalid egress dispatcher');
  }
  return {
    destination: text(value.destination),
    txnId: text(value.txnId),
    body: text(value.body),
    mode: value.mode,
  };
}
function responseOf(raw: unknown) {
  return { pdus: sendVerdicts(raw) };
}
async function held(conn: Conn, destination: string, txnId: string) {
  return (await conn.query(
    'SELECT * FROM facade_egress WHERE destination=? AND txn_id=?',
    [destination, txnId],
  ))[0];
}

export class EgressOwner {
  constructor(
    private readonly db: Database,
    private readonly pairings: Pairings,
    private readonly dispatch: Dispatch,
  ) {}

  private async authorize(record: LinkRecord) {
    const grant = await this.pairings.active();
    const pairing = grant.body.transcript.body.context.id;
    if (
      record.source !== 'home' || record.incarnation !== pairing ||
      record.type !== 'egress' || record.version !== 1
    ) {
      throw new LinkError(
        'LINK_UNPAIRED',
        'egress does not match active home grant',
        403,
      );
    }
    return { pairing, revision: grant.body.revision };
  }

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const record = await journal.next('home', stream);
    if (!record) return false;
    const auth = await this.authorize(record);
    const payload = object(record.payload);
    const envelope = envelopeOf(payload);
    if (record.stream !== 'egress:' + envelope.destination) {
      diverged('wrong egress stream');
    }
    const check = async (conn: Conn) => {
      if (
        !(await conn.query(
          "SELECT 1 FROM facade_pairings WHERE id=? AND state='paired' AND revision=?",
          [auth.pairing, auth.revision],
        )).length
      ) {
        throw new LinkError('LINK_UNPAIRED', 'egress grant changed', 403);
      }
    };
    if (payload.kind === 'propose') {
      const body = object(JSON.parse(envelope.body));
      if (
        body.origin !==
          (await this.pairings.active()).body.transcript.body.context.server ||
        !Array.isArray(body.pdus) ||
        (body.edus !== undefined && !Array.isArray(body.edus))
      ) {
        diverged('invalid frozen federation envelope');
      }
      // Randomness is prepared outside the retryable transaction. Replays use
      // the retained fence rather than minting another dispatch authority.
      const fence = crypto.randomUUID();
      const grant = await this.db.tx(async (conn) => {
        await check(conn);
        const prior = await held(conn, envelope.destination, envelope.txnId);
        if (prior) {
          if (
            prior.body !== envelope.body || prior.mode !== envelope.mode ||
            prior.pairing !== auth.pairing
          ) diverged('changed egress proposal');
          return {
            fence: String(prior.fence),
            response: prior.result_json === null
              ? null
              : JSON.parse(String(prior.result_json)),
          };
        }
        if (
          (await conn.query(
            'SELECT 1 FROM facade_egress WHERE destination=? AND result_json IS NULL',
            [envelope.destination],
          )).length
        ) {
          throw new LinkError(
            'LINK_UNAVAILABLE',
            'destination has an unresolved transaction',
            503,
          );
        }
        await conn.execute(
          'INSERT INTO facade_egress(destination,txn_id,body,mode,pairing,fence) VALUES(?,?,?,?,?,?)',
          [
            envelope.destination,
            envelope.txnId,
            envelope.body,
            envelope.mode,
            auth.pairing,
            fence,
          ],
        );
        return { fence, response: null };
      });
      let response = grant.response;
      if (envelope.mode === 'facade' && response === null) {
        response = responseOf(await this.dispatch(envelope));
        await this.db.tx(async (conn) => {
          await check(conn);
          await this.finish(
            conn,
            envelope,
            auth.pairing,
            grant.fence,
            response,
          );
        });
      }
      return journal.apply('home', stream, async (conn, next) => {
        if (next.hash !== record.hash) diverged('egress apply changed');
        await check(conn);
        return { fence: grant.fence, response };
      });
    }
    if (payload.kind !== 'complete' || envelope.mode !== 'direct') {
      diverged('invalid egress completion');
    }
    const fence = text(payload.fence);
    const response = responseOf(payload.response);
    return journal.apply('home', stream, async (conn, next) => {
      if (next.hash !== record.hash) diverged('egress apply changed');
      await check(conn);
      await this.finish(conn, envelope, auth.pairing, fence, response);
      return { fence, response };
    });
  }

  private async finish(
    conn: Conn,
    envelope: EgressEnvelope,
    pairing: string,
    fence: string,
    response: unknown,
  ) {
    const prior = await held(conn, envelope.destination, envelope.txnId);
    if (
      !prior || prior.fence !== fence || prior.pairing !== pairing ||
      prior.body !== envelope.body || prior.mode !== envelope.mode
    ) diverged('egress completion has no matching dispatch fence');
    const encoded = canonicalJson(response);
    if (prior.result_json !== null && prior.result_json !== encoded) {
      diverged('changed egress result');
    }
    await conn.execute(
      'UPDATE facade_egress SET result_json=? WHERE destination=? AND txn_id=?',
      [encoded, envelope.destination, envelope.txnId],
    );
  }
}
