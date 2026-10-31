// api/engine/room/signer.ts — the injected event signer: the tenant file
// and its key arrive in stage 4, so callers inject the signing identity.
// Tests use a fixed key via #engine/signing-primitives.js.
export interface Signer {
  readonly serverName: string;
  // The full key id — used verbatim as the signatures map key
  // ('ed25519:…').
  readonly keyId: string;
  // Sign the canonical bytes of the (redacted) event; returns the base64
  // signature.
  sign(canonical: string): Promise<string>;
}
