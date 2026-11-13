# Recorded optional peer fields

`tuwunel-public-rooms.json.bin` is the unchanged response body of an actual signed
`POST /_matrix/federation/v1/publicRooms` to stock tuwunel 1.8.2 in the dedicated
communico-interop VM. The independent caller was stock Synapse 1.156.0's signing
identity, with normal test-CA TLS verification. Request: limit 50 and an empty
generic_search_term filter. No server source or response bytes were modified.

SHA256: `a39fdb3e66e31da9ea3ad46ee70fe05115c95c2d786291d4081ddee321691954`.
The complete page carries explicit null next_batch and prev_batch. The remote
decoder treats those optional values as absent and emits no client null tokens.
The pinned v1.16 schemas are not changed to describe this compatibility as a
normative nullable string.

The shared optionalField helper applies the user's general peer-response rule:
optional null is absent unless the field's specification gives null meaning;
required fields and invalid non-null values still refuse. It is shallow, not a
recursive JSON scrubber. Signed key documents retain their original signed JSON
and use decoded defaults/projections; opaque event content and unknown extensions
are never rewritten.
