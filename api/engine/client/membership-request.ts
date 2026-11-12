import { objectParameter, stringParameter } from '#engine/operation.ts';
import { MatrixError } from '#engine/matrix-error.ts';

// Membership and redaction share the same optional reason contract. Validate
// before dispatch, including idempotent joins, without discarding extensions.
export function membershipContent(
  value: unknown,
): Record<string, unknown> & { reason?: string } {
  const content = objectParameter(value, 'body');
  stringParameter(content.reason, 'reason');
  return content as Record<string, unknown> & { reason?: string };
}

export function joinContent(value: unknown) {
  const content = membershipContent(value);
  if (content.third_party_signed !== undefined) {
    throw new MatrixError(
      400,
      'M_UNRECOGNIZED',
      'Identity-server invitations are disabled',
    );
  }
  return content;
}
