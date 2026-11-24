// Retain original signed evidence for home. F2 also delivers device updates to
// the local owner; F1 remains mailbox-only. To-device delivery belongs to B5.
import { config } from '#engine/config.ts';
import { deviceDelta } from '#engine/e2ee-remote.ts';
import { publicSigning } from '#engine/e2ee-public-signing.ts';
import { domainOf } from '#engine/ids.ts';
import { MatrixError } from '#engine/matrix-error.ts';
import { UpstreamError } from '#engine/net/upstream-error.ts';
import { type EduState, PermanentEduRefusal } from '#engine/federation/edus.ts';
import { eduEnvelope } from '#engine/federation/peer-json.ts';
import { decodeToDevice } from '#engine/federation/todevice.ts';
import { dispatchTransactionEdu } from '#engine/federation/transactions.ts';
import type { ToDeviceIngressReceipt } from '#engine/tenant/todevice-routing.ts';

export type IngressEduDisposition =
  | {
    kind: 'retained' | 'expired' | 'ignored';
    type: string;
    policy?: 'legacy';
  }
  | { kind: 'routed'; type: string; receipt: ToDeviceIngressReceipt }
  | { kind: 'refused'; type: string; errcode: string; error: string };

export async function acceptIngressEdu(
  origin: string,
  self: string,
  raw: unknown,
  edus: Pick<EduState, 'dispatch'>,
  phase = 'f1',
  toDevice?: (origin: string, raw: unknown) => Promise<ToDeviceIngressReceipt>,
  receivedMs = Date.now(),
): Promise<IngressEduDisposition> {
  const { type, content } = eduEnvelope(raw);
  try {
    switch (type) {
      case 'm.direct_to_device':
        decodeToDevice(origin, self, content);
        if (phase === 'f2') {
          if (!toDevice) {
            throw new MatrixError(
              503,
              'M_UNAVAILABLE',
              'to-device owner unavailable',
            );
          }
          const receipt = await toDevice(origin, content);
          return receipt.policy === 'legacy'
            ? { kind: 'retained', type, policy: 'legacy' }
            : { kind: 'routed', type, receipt };
        }
        return { kind: 'retained', type, policy: 'legacy' };
      case 'm.device_list_update':
      case 'm.signing_key_update':
        if (
          typeof content.user_id !== 'string' ||
          domainOf(content.user_id) !== origin || origin === self
        ) {
          return { kind: 'ignored', type };
        }
        if (type === 'm.device_list_update') {
          deviceDelta(content, config().e2ee);
        } else publicSigning(content, content.user_id, config().e2ee);
        // The existing service owns tracking, signatures and predecessor recovery
        // at each replica. This child runs outside the mailbox transaction.
        if (phase === 'f2') {
          await dispatchTransactionEdu(origin, raw, edus, true);
        }
        return { kind: 'retained', type };
      case 'm.receipt':
        await dispatchTransactionEdu(origin, raw, edus);
        return { kind: 'retained', type };
      case 'm.typing':
      case 'm.presence':
        if (phase === 'f2') {
          // Only live admission delivers activity. The retained home drain always
          // expires this tail; retry never supplies a new receipt lifetime.
          await dispatchTransactionEdu(origin, raw, edus, false, receivedMs);
          return { kind: 'retained', type };
        }
        return { kind: 'expired', type };
      default:
        return { kind: 'ignored', type };
    }
  } catch (error) {
    if (error instanceof PermanentEduRefusal || error instanceof MatrixError) {
      if (
        error instanceof MatrixError && ![400, 413, 429].includes(error.status)
      ) throw error;
      return {
        kind: 'refused',
        type,
        errcode: error.errcode,
        error: error.message,
      };
    }
    if (
      error instanceof UpstreamError &&
      ['protocol', 'validation'].includes(error.category)
    ) {
      return {
        kind: 'refused',
        type,
        errcode: 'M_BAD_JSON',
        error: error.message,
      };
    }
    throw error;
  }
}
