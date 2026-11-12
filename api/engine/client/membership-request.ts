import { objectParameter, stringParameter } from '#engine/operation.ts';

// Membership and redaction share the same optional reason contract. Validate
// before dispatch, including idempotent joins, without discarding extensions.
export function membershipContent(
  value: unknown,
): Record<string, unknown> & { reason?: string } {
  const content = objectParameter(value, 'body');
  stringParameter(content.reason, 'reason');
  return content as Record<string, unknown> & { reason?: string };
}
