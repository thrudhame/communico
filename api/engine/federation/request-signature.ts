// One canonical request representation for live authentication and retained
// admission evidence. The exact target includes its original query string.
import { canonicalJson } from '#engine/canonical.ts';

export type SignedRequest = {
  method: string;
  uri: string;
  authorization: string | null;
  body: Uint8Array;
};

export function requestCanonical(
  destination: string,
  request: SignedRequest,
  origin: string,
): string {
  const value: Record<string, unknown> = {
    method: request.method,
    uri: request.uri,
    origin,
    destination,
  };
  if (request.body.length) {
    value.content = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(request.body),
    );
  }
  return canonicalJson(value);
}
