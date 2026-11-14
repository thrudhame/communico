// Immutable record exchange. Received and applied are different durable facts.
// This owner never runs a network call or a second-file transaction in db.tx.
import { canonicalJson } from '#engine/canonical.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import {
  assertCapability,
  type Capability,
  type Cut,
  cutOf,
  EMPTY_CUT,
  integer,
  LinkError,
  type LinkRecord,
  object,
  recordHash,
  recordOf,
  type Stream,
  streamOf,
  text,
} from './protocol.ts';

type Direction = 'in' | 'out';
export type Heads = Stream & { received: Cut; applied: Cut };
export type Page = { records: LinkRecord[]; head: Cut };
export type PageLimits = { maxBytes: number; maxItems: number };
export type TerminalResult = Cut & { result: unknown };
export type Acknowledgement = {
  received: Cut;
  applied: Cut;
  results: TerminalResult[];
};
type Append = Stream & {
  type: string;
  version: number;
  operationId: string;
  payload: unknown;
};

function key(peer: string, direction: Direction, stream: Stream) {
  return [peer, direction, stream.source, stream.incarnation, stream.stream];
}
function sameStream(a: Stream, b: Stream) {
  return a.source === b.source && a.incarnation === b.incarnation &&
    a.stream === b.stream;
}
function diverged(message: string): never {
  throw new LinkError('LINK_DIVERGED', message);
}
async function headsInTx(
  conn: Conn,
  peer: string,
  direction: Direction,
  stream: Stream,
): Promise<Heads> {
  const rows = await conn.query(
    'SELECT received,received_hash,applied,applied_hash FROM facade_streams WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=?',
    key(peer, direction, stream),
  );
  if (rows.length === 0) {
    return { ...stream, received: { ...EMPTY_CUT }, applied: { ...EMPTY_CUT } };
  }
  return {
    ...stream,
    received: {
      sequence: Number(rows[0].received),
      hash: String(rows[0].received_hash),
    },
    applied: {
      sequence: Number(rows[0].applied),
      hash: String(rows[0].applied_hash),
    },
  };
}
async function ensureStream(
  conn: Conn,
  peer: string,
  direction: Direction,
  stream: Stream,
) {
  await conn.execute(
    'INSERT INTO facade_streams(peer,direction,source,incarnation,stream) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING',
    key(peer, direction, stream),
  );
}
async function insert(
  conn: Conn,
  peer: string,
  direction: Direction,
  record: LinkRecord,
  encoded: string,
) {
  await conn.execute(
    'INSERT INTO facade_records(peer,direction,source,incarnation,stream,sequence,operation_id,hash,record_json,bytes) VALUES(?,?,?,?,?,?,?,?,?,?)',
    [
      ...key(peer, direction, record),
      record.sequence,
      record.operationId,
      record.hash,
      encoded,
      new TextEncoder().encode(encoded).byteLength,
    ],
  );
}
async function recordInTx(
  conn: Conn,
  peer: string,
  direction: Direction,
  stream: Stream,
  sequence: number,
) {
  const rows = await conn.query(
    'SELECT record_json,result_json FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence=?',
    [...key(peer, direction, stream), sequence],
  );
  return rows.length === 0 ? null : {
    record: recordOf(JSON.parse(String(rows[0].record_json))),
    result: rows[0].result_json === null ? null : String(rows[0].result_json),
  };
}

/** May be composed into the owning server projection transaction. */
export async function appendRecord(
  conn: Conn,
  peer: string,
  input: Append,
): Promise<LinkRecord> {
  text(peer);
  const stream = streamOf(input);
  const operationId = text(input.operationId);
  const type = text(input.type);
  const version = integer(input.version, 1);
  const payload = JSON.parse(canonicalJson(input.payload));
  const held = await conn.query(
    "SELECT record_json FROM facade_records WHERE peer=? AND direction='out' AND source=? AND incarnation=? AND operation_id=?",
    [peer, stream.source, stream.incarnation, operationId],
  );
  if (held.length) {
    const record = recordOf(JSON.parse(String(held[0].record_json)));
    if (
      !sameStream(stream, record) || record.type !== type ||
      record.version !== version ||
      canonicalJson(record.payload) !== canonicalJson(payload)
    ) {
      diverged('operation identity reused with changed content');
    }
    return record;
  }
  const heads = await headsInTx(conn, peer, 'out', stream);
  const next = {
    ...stream,
    sequence: integer(heads.received.sequence + 1, 1),
    previous: heads.received.hash,
    type,
    version,
    operationId,
    payload,
  };
  const record = { ...next, hash: recordHash(next) };
  await ensureStream(conn, peer, 'out', stream);
  await insert(conn, peer, 'out', record, canonicalJson(record));
  await conn.execute(
    'UPDATE facade_streams SET received=?,received_hash=? WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=?',
    [record.sequence, record.hash, ...key(peer, 'out', stream)],
  );
  return record;
}

export class Journal {
  constructor(
    private readonly db: Database,
    private readonly supported: readonly Capability[],
  ) {}

  async append(peer: string, record: Append): Promise<LinkRecord> {
    assertCapability(
      { ...record, sequence: 1, previous: '', hash: '' },
      this.supported,
    );
    return await this.db.tx((conn) => appendRecord(conn, peer, record));
  }

  heads(peer: string, direction: Direction, stream: Stream): Promise<Heads> {
    return this.db.tx((conn) => headsInTx(conn, peer, direction, stream));
  }

  async streams(peer: string, direction: Direction): Promise<Heads[]> {
    return await this.db.tx(async (conn) => {
      const rows = await conn.query(
        'SELECT source,incarnation,stream,received,received_hash,applied,applied_hash FROM facade_streams WHERE peer=? AND direction=? ORDER BY source,incarnation,stream',
        [peer, direction],
      );
      return rows.map((row) => ({
        source: String(row.source),
        incarnation: String(row.incarnation),
        stream: String(row.stream),
        received: {
          sequence: Number(row.received),
          hash: String(row.received_hash),
        },
        applied: {
          sequence: Number(row.applied),
          hash: String(row.applied_hash),
        },
      }));
    });
  }

  /** Validate the entire page before committing any received record/cursor. */
  async receive(peer: string, raw: readonly unknown[]): Promise<Heads | null> {
    text(peer);
    const records = raw.map((value) => {
      const record = recordOf(value);
      assertCapability(record, this.supported);
      return recordOf(JSON.parse(canonicalJson(record)));
    });
    if (!records.length) return null;
    const stream = streamOf(records[0]);
    if (records.some((record) => !sameStream(record, stream))) {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'a page must name one stream',
        400,
      );
    }
    return await this.db.tx(async (conn) => {
      let head = (await headsInTx(conn, peer, 'in', stream)).received;
      await ensureStream(conn, peer, 'in', stream);
      for (const record of records) {
        const prior = await recordInTx(
          conn,
          peer,
          'in',
          stream,
          record.sequence,
        );
        if (prior) {
          if (canonicalJson(prior.record) !== canonicalJson(record)) {
            diverged('changed record replay');
          }
          continue;
        }
        if (
          record.sequence !== head.sequence + 1 || record.previous !== head.hash
        ) diverged('record hole or predecessor mismatch');
        const duplicate = await conn.query(
          "SELECT 1 FROM facade_records WHERE peer=? AND direction='in' AND source=? AND incarnation=? AND operation_id=?",
          [peer, stream.source, stream.incarnation, record.operationId],
        );
        if (duplicate.length) {
          diverged('operation identity repeated at another sequence');
        }
        await insert(conn, peer, 'in', record, canonicalJson(record));
        head = { sequence: record.sequence, hash: record.hash };
      }
      await conn.execute(
        'UPDATE facade_streams SET received=?,received_hash=? WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=?',
        [head.sequence, head.hash, ...key(peer, 'in', stream)],
      );
      return headsInTx(conn, peer, 'in', stream);
    });
  }

  async page(
    peer: string,
    direction: Direction,
    stream: Stream,
    after: number,
    limits: PageLimits,
  ): Promise<Page> {
    integer(after);
    integer(limits.maxBytes, 1);
    integer(limits.maxItems, 1);
    return await this.db.tx(async (conn) => {
      const head = (await headsInTx(conn, peer, direction, stream)).received;
      if (after > head.sequence) diverged('page cursor is ahead of source');
      // Select byte metadata first; do not hydrate maxItems oversized payloads.
      const candidates = await conn.query(
        'SELECT sequence,bytes FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence>? ORDER BY sequence LIMIT ?',
        [...key(peer, direction, stream), after, limits.maxItems],
      );
      let bytes = 0;
      const records: LinkRecord[] = [];
      for (const row of candidates) {
        const size = Number(row.bytes);
        if (records.length && bytes + size > limits.maxBytes) break;
        const entry = await recordInTx(
          conn,
          peer,
          direction,
          stream,
          Number(row.sequence),
        );
        if (!entry) diverged('missing retained source record');
        records.push(entry.record);
        bytes += size;
      }
      return { records, head };
    });
  }

  async next(peer: string, stream: Stream): Promise<LinkRecord | null> {
    return await this.db.tx(async (conn) => {
      const heads = await headsInTx(conn, peer, 'in', stream);
      return (await recordInTx(
        conn,
        peer,
        'in',
        stream,
        heads.applied.sequence + 1,
      ))?.record ?? null;
    });
  }

  /** Call only after idempotent cross-file domain completion. For server-owned
   * effects use apply(), which commits effects and completion in the same tx. */
  async complete(
    peer: string,
    stream: Stream,
    cut: Cut,
    result: unknown,
  ): Promise<Heads> {
    return await this.db.tx((conn) =>
      this.finish(conn, peer, stream, cut, canonicalJson(result))
    );
  }

  private async finish(
    conn: Conn,
    peer: string,
    stream: Stream,
    rawCut: Cut,
    encoded: string,
  ): Promise<Heads> {
    const cut = cutOf(rawCut);
    const heads = await headsInTx(conn, peer, 'in', stream);
    const held = await recordInTx(conn, peer, 'in', stream, cut.sequence);
    if (!held || held.record.hash !== cut.hash) {
      diverged('completion has no matching received record');
    }
    if (held.result !== null) {
      if (held.result !== encoded) diverged('changed completed result');
      return heads;
    }
    if (cut.sequence !== heads.applied.sequence + 1) {
      diverged('completion would skip unapplied record');
    }
    await conn.execute(
      'UPDATE facade_records SET result_json=? WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence=?',
      [encoded, ...key(peer, 'in', stream), cut.sequence],
    );
    await conn.execute(
      'UPDATE facade_streams SET applied=?,applied_hash=? WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=?',
      [cut.sequence, cut.hash, ...key(peer, 'in', stream)],
    );
    return { ...heads, applied: cut };
  }

  apply(
    peer: string,
    stream: Stream,
    handler: (conn: Conn, record: LinkRecord) => Promise<unknown>,
  ): Promise<boolean> {
    return this.db.tx(async (conn) => {
      const heads = await headsInTx(conn, peer, 'in', stream);
      const next = await recordInTx(
        conn,
        peer,
        'in',
        stream,
        heads.applied.sequence + 1,
      );
      if (!next) return false;
      const result = await handler(conn, next.record);
      await this.finish(conn, peer, stream, {
        sequence: next.record.sequence,
        hash: next.record.hash,
      }, canonicalJson(result));
      return true;
    });
  }

  async ack(
    peer: string,
    stream: Stream,
    rawReceived: Cut,
    rawApplied: Cut,
    rawResults: readonly unknown[] = [],
  ): Promise<{ received: Cut; applied: Cut }> {
    const received = cutOf(rawReceived);
    const applied = cutOf(rawApplied);
    if (applied.sequence > received.sequence) {
      diverged('applied ACK exceeds received ACK');
    }
    const results = rawResults.map((raw) => {
      const value = object(raw);
      const cut = cutOf(value);
      if (
        cut.sequence === 0 || cut.sequence > applied.sequence ||
        !Object.hasOwn(value, 'result')
      ) {
        diverged('terminal result is outside applied ACK');
      }
      return { ...cut, encoded: canonicalJson(value.result) };
    });
    if (
      new Set(results.map((result) => result.sequence)).size !== results.length
    ) {
      diverged('duplicate terminal result');
    }
    return await this.db.tx(async (conn) => {
      for (const cut of [received, applied]) {
        if (cut.sequence === 0) continue;
        const record = await recordInTx(
          conn,
          peer,
          'out',
          stream,
          cut.sequence,
        );
        if (!record || record.record.hash !== cut.hash) {
          diverged('ACK does not name retained outgoing record');
        }
      }
      const rows = await conn.query(
        'SELECT received,received_hash,applied,applied_hash FROM facade_export_acks WHERE peer=? AND source=? AND incarnation=? AND stream=?',
        [peer, stream.source, stream.incarnation, stream.stream],
      );
      if (
        rows.length &&
        (received.sequence < Number(rows[0].received) ||
          applied.sequence < Number(rows[0].applied))
      ) {
        diverged('ACK regression');
      }
      for (const result of results) {
        const held = await recordInTx(
          conn,
          peer,
          'out',
          stream,
          result.sequence,
        );
        if (!held || held.record.hash !== result.hash) {
          diverged('terminal result does not name outgoing record');
        }
        if (held.result !== null && held.result !== result.encoded) {
          diverged('changed remote terminal result');
        }
        await conn.execute(
          'UPDATE facade_records SET result_json=? WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence=?',
          [result.encoded, ...key(peer, 'out', stream), result.sequence],
        );
      }
      const previous = rows.length ? Number(rows[0].applied) : 0;
      const [completed] = await conn.query(
        'SELECT count(*) AS n FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence>? AND sequence<=? AND result_json IS NOT NULL',
        [...key(peer, 'out', stream), previous, applied.sequence],
      );
      if (Number(completed.n) !== applied.sequence - previous) {
        diverged('applied ACK is missing terminal results');
      }
      await conn.execute(
        'INSERT INTO facade_export_acks(peer,source,incarnation,stream,received,received_hash,applied,applied_hash) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(peer,source,incarnation,stream) DO UPDATE SET received=excluded.received,received_hash=excluded.received_hash,applied=excluded.applied,applied_hash=excluded.applied_hash',
        [
          peer,
          stream.source,
          stream.incarnation,
          stream.stream,
          received.sequence,
          received.hash,
          applied.sequence,
          applied.hash,
        ],
      );
      return { received, applied };
    });
  }

  async acknowledgement(
    peer: string,
    stream: Stream,
    rawAfter: Cut,
    limits: PageLimits,
  ): Promise<Acknowledgement> {
    const after = cutOf(rawAfter);
    integer(limits.maxBytes, 1);
    integer(limits.maxItems, 1);
    return await this.db.tx(async (conn) => {
      const heads = await headsInTx(conn, peer, 'in', stream);
      if (after.sequence > heads.applied.sequence) {
        diverged('result cursor exceeds applied cut');
      }
      if (after.sequence) {
        const held = await recordInTx(conn, peer, 'in', stream, after.sequence);
        if (!held || held.record.hash !== after.hash) {
          diverged('result cursor digest mismatch');
        }
      }
      const candidates = await conn.query(
        'SELECT sequence,hash,length(CAST(result_json AS BLOB)) AS bytes FROM facade_records WHERE peer=? AND direction=? AND source=? AND incarnation=? AND stream=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
        [
          ...key(peer, 'in', stream),
          after.sequence,
          heads.applied.sequence,
          limits.maxItems,
        ],
      );
      const results: TerminalResult[] = [];
      let applied = after;
      let bytes = 0;
      for (const row of candidates) {
        // The terminal envelope has a fixed numeric/hash overhead; include it in
        // the byte target without hydrating all candidate result bodies first.
        const cut = { sequence: Number(row.sequence), hash: String(row.hash) };
        const size = Number(row.bytes) +
          new TextEncoder().encode(canonicalJson({ ...cut, result: null }))
            .byteLength -
          4;
        if (results.length && bytes + size > limits.maxBytes) break;
        const held = await recordInTx(conn, peer, 'in', stream, cut.sequence);
        if (
          !held || held.result === null || cut.sequence !== applied.sequence + 1
        ) {
          diverged('missing retained terminal result');
        }
        results.push({ ...cut, result: JSON.parse(held.result) });
        applied = cut;
        bytes += size;
      }
      return { received: heads.received, applied, results };
    });
  }

  async acknowledged(
    peer: string,
    stream: Stream,
  ): Promise<{ received: Cut; applied: Cut }> {
    const rows = await this.db.query(
      'SELECT received,received_hash,applied,applied_hash FROM facade_export_acks WHERE peer=? AND source=? AND incarnation=? AND stream=?',
      [peer, stream.source, stream.incarnation, stream.stream],
    );
    return rows.length
      ? {
        received: {
          sequence: Number(rows[0].received),
          hash: String(rows[0].received_hash),
        },
        applied: {
          sequence: Number(rows[0].applied),
          hash: String(rows[0].applied_hash),
        },
      }
      : { received: { ...EMPTY_CUT }, applied: { ...EMPTY_CUT } };
  }

  async result(
    peer: string,
    direction: Direction,
    stream: Stream,
    rawCut: Cut,
  ): Promise<{ result: unknown } | null> {
    const cut = cutOf(rawCut);
    return await this.db.tx(async (conn) => {
      const held = await recordInTx(
        conn,
        peer,
        direction,
        stream,
        cut.sequence,
      );
      if (!held || held.record.hash !== cut.hash) {
        diverged('result does not name retained record');
      }
      return held.result === null ? null : { result: JSON.parse(held.result) };
    });
  }
}
