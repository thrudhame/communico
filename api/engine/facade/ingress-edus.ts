// F1 has no facade-owned device inbox. Validate the normal wire inputs and
// retain their original signed transaction for home target expansion. Volatile
// activity is explicitly expired, not resurrected when a partition heals.
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

export type IngressEduDisposition =
  | { kind: 'retained' | 'expired' | 'ignored'; type: string }
  | { kind: 'refused'; type: string; errcode: string; error: string };

export async function acceptIngressEdu(
  origin: string,
  self: string,
  raw: unknown,
  edus: Pick<EduState, 'dispatch'>,
): Promise<IngressEduDisposition> {
  const { type, content } = eduEnvelope(raw);
  try {
    switch (type) {
      case 'm.direct_to_device':
        decodeToDevice(origin, self, content);
        return { kind: 'retained', type };
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
        // Subordinate signature/previous-stream checks use home's actual learned
        // keys/tracking at delivery, exactly as ordinary reliable acceptance.
        return { kind: 'retained', type };
      case 'm.receipt':
        await dispatchTransactionEdu(origin, raw, edus);
        return { kind: 'retained', type };
      case 'm.typing':
      case 'm.presence':
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
