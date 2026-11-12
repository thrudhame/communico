# Recorded stock federation responses

Captured on 2026-11-12 in `communico-interop` on Ark, from stock Synapse 1.156.0
and tuwunel 1.8.2. The clients used the existing guest-local test CA and normal
X-Matrix request signatures. No counterpart settings or product code were changed.
Synthetic users and rooms contain no real-user data.

`recordings.json` retains each exact HTTP representation body as Base64, its
SHA-256, response headers, status, request method/path and producer version.
Signed public documents are intact, not normalized or resigned. Authorization,
access tokens, private signing material and attachment-decryption keys are not
fixtures. These are decoded HTTP bodies, not captured TLS records or raw chunk
streams. The original files remain outside the repository under
`~/TemporaryFiles/communico/plans/overnight-1/evidence/p1-interop/recordings/`.

The early event/state 404 recordings used a fixture driver's incorrect reference
ID. The later `*-success` records use the actual stock timeline event ID and
contain the successful event/state/history families. Both are retained honestly.
Synapse produces v1 membership wrappers and a nonempty signed notary response;
tuwunel's corresponding unavailable endpoints are recorded as 404, not invented
successes. Device snapshots include the before-login, un-cross-signed forms and
the populated Element device forms, including Synapse's deployed null optionals.

Media payload hashes were independently extracted using Python's standard MIME
parser in the guest, not communico's parser. Both download ciphertexts match the
hash declared in the real Element attachment. Thumbnail PNG dimensions are those
actually returned by each stock server, not the requested dimensions: Synapse
may return its larger precomputed size. Communico's client thumbnail owner then
produces and renders the requested dimensions, as separately proved by Element.
