// Signatures are excluded from a key's signed body. Export only the owner's
// public signatures and, for a client query, that requester's private overlay.
export function keyView(
  key: Record<string, unknown>,
  owner: string,
  requester?: string,
): Record<string, unknown> {
  const signatures: Record<string, unknown> = Object.create(null);
  for (
    const [signer, value] of Object.entries(
      key.signatures as Record<string, unknown>,
    )
  ) {
    if (signer === owner || signer === requester) signatures[signer] = value;
  }
  return { ...key, signatures };
}
