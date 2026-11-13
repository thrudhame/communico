import { MatrixError } from '#engine/matrix-error.ts';
import { objectOf, stringOf } from '#engine/net/json.ts';
import { protocol } from '#engine/net/upstream-error.ts';
import { transactionEnvelope } from './peer-json.ts';

export function transactionRequest(value: unknown, origin: string) {
  const raw = objectOf(value, 'transaction');
  if (stringOf(raw.origin, 'transaction') !== origin) {
    throw new MatrixError(
      403,
      'M_FORBIDDEN',
      'transaction origin does not match the authenticated server',
    );
  }
  const timestamp = raw.origin_server_ts;
  if (
    typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    protocol(
      'transaction',
      'expected nonnegative origin_server_ts safe integer',
    );
  }
  const { pdus, edus } = transactionEnvelope(raw);
  return { timestamp, pdus, edus };
}
