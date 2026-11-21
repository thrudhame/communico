// Home independently verifies the original admission and applies its children
// through normal domain owners. A journal ACK follows durable child completion,
// never the facade's PDU verdict or a copied room publication position.
import { Buffer } from 'node:buffer';
import { canonicalJson } from '#engine/canonical.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { eduEnvelope } from '#engine/federation/peer-json.ts';
import { decodeToDevice } from '#engine/federation/todevice.ts';
import { PermanentEduRefusal } from '#engine/federation/edus.ts';
import { openTenant } from '#engine/tenant/index.ts';
import { config } from '#engine/config.ts';
import type { ToDeviceIngressReceipt } from '#engine/tenant/todevice-routing.ts';
import {
  absentTransactionRoom,
  dispatchTransactionEdu,
  receiveTransactionRoom,
  type TransactionDeps,
  transactionRooms,
} from '#engine/federation/transactions.ts';
import { openRoom } from '#engine/room/index.ts';
import { recoveryPack } from '#engine/room/recovery-pack.ts';
import type { Conn, Database } from '#engine/store/db.ts';
import {
  ingressOperation,
  sameIngressRequest,
  verifyIngressRequest,
} from './mailbox.ts';
import type { Journal } from './journal.ts';
import type { Pairings } from './pairing.ts';
import { LinkError, object, type Stream, text } from './protocol.ts';

export class HomeIngress {
  constructor(
    private readonly db: Database,
    private readonly options: {
      peer: string;
      pairing: string;
      pairings: Pairings;
      transaction: TransactionDeps;
      toDevice?(
        origin: string,
        raw: unknown,
        receipt: ToDeviceIngressReceipt,
      ): Promise<unknown>;
    },
  ) {}

  async apply(journal: Journal, stream: Stream): Promise<boolean> {
    const { peer, pairing, pairings, transaction } = this.options;
    const record = await journal.next(peer, stream);
    if (!record) return false;
    if (record.type !== 'ingress' || ![1, 2, 3].includes(record.version)) {
      throw new LinkError(
        'LINK_CAPABILITY_MISMATCH',
        'not an ingress obligation',
      );
    }
    const binding = await pairings.connection(pairing);
    if (
      binding.state !== 'paired' || !binding.grant ||
      record.source !== peer || binding.context.node !== peer ||
      record.incarnation !== binding.transcript?.body.incarnation
    ) {
      throw new LinkError(
        'LINK_IDENTITY_MISMATCH',
        'ingress does not match the home grant',
        403,
      );
    }
    const payload = object(record.payload);
    if (payload.kind !== 'ingress' || !Array.isArray(payload.rooms)) {
      throw new LinkError('LINK_BAD_RECORD', 'invalid ingress obligation', 400);
    }
    if (
      record.version === 1
        ? payload.phase !== undefined
        : payload.phase !== 'f2'
    ) {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'ingress phase differs from reader version',
        400,
      );
    }
    const phase = record.version >= 2 ? 'f2' : 'f1';
    const txnId = text(payload.txnId);
    const verified = await verifyIngressRequest(
      txnId,
      payload.evidence,
      transaction.self,
    );
    const { origin } = verified.evidence;
    if (
      stream.stream !== 'ingress:' + origin ||
      record.operationId !== ingressOperation(origin, txnId)
    ) {
      throw new LinkError('LINK_DIVERGED', 'ingress identity diverged');
    }
    const rooms = transactionRooms(verified.transaction.pdus);
    const eduManifest = new Map<number, Record<string, unknown>>();
    if (record.version === 3) {
      if (
        !Array.isArray(payload.edus) ||
        payload.edus.length !== verified.transaction.edus.length
      ) {
        throw new LinkError(
          'LINK_BAD_RECORD',
          'ingress EDU manifest mismatch',
          400,
        );
      }
      for (const raw of payload.edus) {
        const entry = object(raw);
        if (
          !Number.isSafeInteger(entry.index) || Number(entry.index) < 0 ||
          Number(entry.index) >= payload.edus.length ||
          eduManifest.has(Number(entry.index))
        ) {
          throw new LinkError(
            'LINK_BAD_RECORD',
            'ingress EDU index mismatch',
            400,
          );
        }
        eduManifest.set(Number(entry.index), object(entry.disposition));
      }
    }
    const recovery = new Map(payload.rooms.map((raw) => {
      const room = object(raw);
      return [text(room.roomId), room] as const;
    }));
    if (
      recovery.size !== payload.rooms.length || recovery.size !== rooms.size ||
      [...rooms.keys()].some((id) => !recovery.has(id))
    ) {
      throw new LinkError(
        'LINK_BAD_RECORD',
        'ingress room manifest mismatch',
        400,
      );
    }
    const revision = binding.grant.body.revision;
    const checkBinding = async (conn: Conn) => {
      const [row] = await conn.query(
        "SELECT state,revision FROM facade_pairings WHERE id=? AND side='home'",
        [pairing],
      );
      if (row?.state !== 'paired' || Number(row.revision) !== revision) {
        throw new LinkError('LINK_UNPAIRED', 'ingress grant changed', 403);
      }
    };
    await this.db.tx(async (conn) => {
      await checkBinding(conn);
      const [held] = await conn.query(
        'SELECT input_hash,evidence_json,ingress_phase FROM facade_ingress WHERE origin=? AND txn_id=?',
        [origin, txnId],
      );
      if (
        held && (held.ingress_phase !== phase || !await sameIngressRequest(
          txnId,
          transaction.self,
          held,
          verified,
        ))
      ) {
        throw new LinkError(
          'LINK_DIVERGED',
          'changed original ingress request',
        );
      }
      if (!held) {
        const encoded = canonicalJson(verified.evidence);
        await conn.execute(
          'INSERT INTO facade_ingress(origin,txn_id,input_hash,evidence_json,bytes,pairing,revision,source,incarnation,ingress_phase) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [
            origin,
            txnId,
            verified.inputHash,
            encoded,
            Buffer.byteLength(encoded),
            pairing,
            revision,
            peer,
            record.incarnation,
            phase,
          ],
        );
      }
    });
    const child = async (
      kind: string,
      key: string,
      run: () => Promise<unknown>,
    ) => {
      const args = [origin, txnId, kind, key];
      const [held] = await this.db.query(
        'SELECT result_json FROM facade_ingress_children WHERE origin=? AND txn_id=? AND kind=? AND child_key=?',
        args,
      );
      if (held) return JSON.parse(String(held.result_json));
      const result = await run();
      await this.db.tx(async (conn) => {
        await checkBinding(conn);
        await conn.execute(
          'INSERT INTO facade_ingress_children(origin,txn_id,kind,child_key,result_json) VALUES(?,?,?,?,?)',
          [...args, canonicalJson(result)],
        );
      });
      return result;
    };
    const roomResults: unknown[] = [],
      eduResults: unknown[] = [],
      failures: unknown[] = [];
    const roomJobs = [...rooms].map(async ([roomId, inputs]) => {
      try {
        roomResults.push(
          await child('room', roomId, async () => {
            const retained = recovery.get(roomId)!;
            if (retained.recovery === null) {
              const result = await absentTransactionRoom(inputs);
              if (canonicalJson(result) !== canonicalJson(retained.result)) {
                throw new LinkError(
                  'LINK_BAD_RECORD',
                  'invalid absent-room disposition',
                  400,
                );
              }
              // The facade has no F1 invite authority. Its saved negative is
              // still truthful, while home must apply its own retained invite
              // transition through the same absent-room owner as direct S2S.
              return {
                roomId,
                result: await absentTransactionRoom(
                  inputs,
                  transaction.rescind
                    ? (pdu) => transaction.rescind!(roomId, pdu)
                    : undefined,
                ),
              };
            }
            const scope = await this.db.tx(async (conn) => {
              await checkBinding(conn);
              const name = 'room:' + roomId;
              const [exported] = await conn.query(
                'SELECT 1 FROM facade_exports WHERE peer=? AND incarnation=? AND scope=?',
                [peer, pairing, name],
              );
              if (exported || phase !== 'f2') return exported;
              // F2 can start a room on the facade under a selected-account
              // grant. Only the verified reverse bootstrap's completed journal
              // cut grants ingress, never mere room-file presence or receipt.
              const [imported] = await conn.query(
                "SELECT r.record_json FROM facade_streams s JOIN facade_scopes v ON v.incarnation=? AND v.scope=s.stream JOIN facade_records r ON r.peer=s.peer AND r.direction=s.direction AND r.source=s.source AND r.incarnation=s.incarnation AND r.stream=s.stream AND r.sequence=s.applied WHERE s.peer=? AND s.direction='in' AND s.source=? AND s.incarnation=? AND s.stream=? AND s.applied>0 AND s.received=s.applied AND s.received_hash=s.applied_hash AND v.ready=1 AND v.pending_hash IS NULL AND v.source_cut>0",
                [pairing, peer, peer, record.incarnation, name],
              );
              if (!imported) return undefined;
              const applied = JSON.parse(String(imported.record_json));
              return applied.type === 'room-replica' && applied.version === 2
                ? imported
                : undefined;
            });
            if (!scope) {
              throw new MatrixError(
                503,
                'M_UNAVAILABLE',
                'ingress room was not granted',
              );
            }
            await openRoom(transaction.store, roomId);
            const result = await receiveTransactionRoom(
              roomId,
              inputs,
              origin,
              {
                ...transaction,
                fetcher: recoveryPack(
                  retained.recovery,
                  roomId,
                  transaction.fetcher,
                ),
              },
              ingressOperation(origin, txnId) + ':home-room:' + roomId,
            );
            return { roomId, result };
          }),
        );
      } catch (error) {
        failures.push(error);
      }
    });
    const eduJob = (async () => {
      for (const [index, raw] of verified.transaction.edus.entries()) {
        try {
          eduResults.push(
            await child('edu', String(index), async () => {
              const { type, content } = eduEnvelope(raw);
              if (type === 'm.typing' || type === 'm.presence') {
                return { index, kind: 'expired', type };
              }
              if (type === 'm.direct_to_device') {
                let input;
                try {
                  input = decodeToDevice(origin, transaction.self, content);
                } catch (error) {
                  if (!(error instanceof PermanentEduRefusal)) throw error;
                }
                if (input) {
                  const disposition = eduManifest.get(index);
                  if (record.version === 3 && disposition?.kind === 'routed') {
                    if (!this.options.toDevice) {
                      throw new MatrixError(
                        503,
                        'M_UNAVAILABLE',
                        'to-device home owner unavailable',
                      );
                    }
                    await this.options.toDevice(
                      origin,
                      content,
                      object(disposition.receipt) as ToDeviceIngressReceipt,
                    );
                  } else {
                    if (
                      record.version === 3 && disposition?.policy !== 'legacy'
                    ) {
                      throw new LinkError(
                        'LINK_BAD_RECORD',
                        'missing frozen to-device disposition',
                        400,
                      );
                    }
                    const tenant = await openTenant(
                      transaction.store,
                      transaction.self,
                    );
                    await tenant.tx((tx) =>
                      tx.toDevice.receive(
                        origin,
                        input.id,
                        input.sender,
                        input.type,
                        transaction.self,
                        input.messages,
                        config().e2ee,
                        'legacy',
                      )
                    );
                  }
                  return { index, kind: 'processed', type };
                }
              }
              await dispatchTransactionEdu(
                origin,
                raw,
                transaction.edus,
                phase === 'f2' &&
                  ['m.device_list_update', 'm.signing_key_update'].includes(
                    type,
                  ),
              );
              return { index, kind: 'processed', type };
            }),
          );
        } catch (error) {
          failures.push(error);
        }
      }
    })();
    await Promise.all([...roomJobs, eduJob]);
    if (failures.length) throw failures[0];
    roomResults.sort((a, b) =>
      canonicalJson(a).localeCompare(canonicalJson(b))
    );
    const result = {
      kind: 'ingress',
      origin,
      txnId,
      rooms: roomResults,
      edus: eduResults,
    };
    return await journal.apply(peer, stream, async (conn, current) => {
      await checkBinding(conn);
      if (current.hash !== record.hash) {
        throw new LinkError('LINK_DIVERGED', 'ingress completion raced');
      }
      await conn.execute(
        'UPDATE facade_ingress SET response_json=?,record_sequence=?,record_hash=? WHERE origin=? AND txn_id=?',
        [canonicalJson(result), record.sequence, record.hash, origin, txnId],
      );
      return result;
    });
  }
}
