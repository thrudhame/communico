// api/engine/federation/keyresolver.ts — the production KeyResolver
// (3c's injected interface) over the server key store: the key for
// (server, keyId) covering the event's validity floor, then the
// redact-strip-verify of the old verifyPduSignature (redact per the
// room version, the id rides out-of-band, the full signatures map
// retained for lookup). Unknown key, expired key and bad signature all
// answer false — the interface's contract; a failure acquiring the key
// answers false too (the key store remembers the failure for
// keyfailminutes, bounding re-dials).
import { redact } from '#engine/eventid.ts';
import type { KeyResolver } from '#engine/room/deps.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Database as Db } from '#engine/store/db.ts';
import { verifyJson } from '#engine/signing-primitives.js';
import { KeyChangeRefused, type KeyStore, keyStore } from './keys.ts';
import { recoverableUpstream } from '#engine/net/upstream-error.ts';

export function productionKeyResolver(
  server: Db,
  signer: Signer,
  keys: Pick<KeyStore, 'getVerifyKey'> = keyStore(server, { signer }),
): KeyResolver {
  return {
    verifyEventSignature: async (args) => {
      let pub: CryptoKey;
      try {
        pub = await keys.getVerifyKey(
          args.server,
          args.keyId,
          args.minValidUntilMs,
          'event',
        );
      } catch (error) {
        if (
          !(error instanceof KeyChangeRefused) && !recoverableUpstream(error)
        ) throw error;
        return false; // key unknown, expired before the floor, unobtainable
      }
      let redacted: Record<string, unknown>;
      try {
        redacted = redact(
          args.pdu as unknown as Record<string, unknown>,
          args.roomVersion,
        );
      } catch {
        return false;
      }
      delete redacted.event_id;
      redacted.signatures = args.pdu.signatures as unknown as Record<
        string,
        Record<string, string>
      >;
      return await verifyJson(redacted, args.server, args.keyId, pub);
    },
  };
}
