import { mediaType } from './fields.ts';
import { protocol } from './upstream-error.ts';

export function decodeJson(
  bytes: Uint8Array,
  contentType: string | null,
  mediaPolicy: 'require-json' | 'discovery' = 'require-json',
): unknown {
  if (
    mediaPolicy === 'require-json' &&
    (contentType === null ||
      mediaType(contentType).value !== 'application/json')
  ) {
    protocol('json', 'expected application/json response');
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (cause) {
    protocol('json', 'invalid UTF-8 JSON response', cause);
  }
}
export function objectOf(
  value: unknown,
  endpoint = 'response',
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    protocol(endpoint, 'expected JSON object');
  }
  return value as Record<string, unknown>;
}
export function arrayOf<T>(
  value: unknown,
  decode: (entry: unknown) => T,
  endpoint = 'response',
): T[] {
  if (!Array.isArray(value)) protocol(endpoint, 'expected JSON array');
  return value.map(decode);
}
export function stringOf(value: unknown, endpoint = 'response'): string {
  if (typeof value !== 'string') protocol(endpoint, 'expected string');
  return value;
}
