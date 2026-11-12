// Synthetic wire-shaped material for schema/state tests, not crypto evidence.
import { b64encodeStd } from '#engine/signing-primitives.js';

export function wireKey(label: string): string {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode(label).subarray(0, 32));
  return b64encodeStd(bytes);
}
export const wireSignature = b64encodeStd(new Uint8Array(64).fill(7));
