# How communico works

This guide describes the current server tree. Source pointers are relative to
this repository and refer to the commit containing this guide. For commands,
configuration paths and operator procedures, start with [README.md](README.md).

## Files and ownership

The application opens one store with room, tenant and server schemas, then
selects the tenant for the configured server name. It serves one tenant per
process; separate tenant files do not imply multi-tenant serving.
(`api/engine/app.ts:61-82`)

| # | File under the store root | Responsibility                                           | Source                                                                    |
| - | ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1 | `rooms/<key>/data.db`     | Room events, graph, state cache, segments and change log | `api/engine/room/schema.ts:10-120`                                        |
| 2 | `tenants/<key>/data.db`   | Tenant signing identity and hosted account data          | `api/engine/tenant/index.ts:337-379`, `api/engine/tenant/schema.ts:1-123` |
| 3 | `server/data.db`          | Cross-room projections and durable server-owned data     | `api/engine/server/schema.ts:1-164`, `api/engine/server/project.ts:1-15`  |

For rooms and tenants, `<key>` is the first 32 hex characters of SHA-256 of
the full identifier. Files have `data.db-log` and `data.db-wal` sidecars;
the stored full identifier is checked when opening its file.
(`api/engine/store/layout.ts:7-36`, `api/engine/store/layout.ts:39-65`,
`api/engine/store/pool.ts:376-409`)

## Room truth and rulebooks

An event is a validated PDU stored once with its indexed type, state key,
sender, depth and timestamp. Mutable knowledge is separate: `event_status`
records standing (`accepted`, `rejected`, `soft_failed`) independently of
grounding (`grounded`, `evidence`, `pending`). Forward and reverse graph
indexes retain the event's `prev_events` and `auth_events` edges.
(`api/engine/room/schema.ts:10-46`, `api/engine/room/events.ts:30-106`)

"Stored PDU" does not mean raw received bytes. Receipt removes `unsigned`,
recomputes and annotates the event id, redacts on content-hash mismatch,
and normally requires a verifying sender-server signature. Rejoin snapshots
allow a resident-signature fallback only for our own historical sender domain.
The event id is the room-version Matrix reference hash, not a second identity
to translate.
(`api/engine/room/verify.ts:151-275`, `api/engine/room/join.ts:59-78`,
`api/engine/eventid.ts:171-192`)

The accepted create event fixes the room version. The registry dispatches
versions 3-12 and refuses unknown versions. The rulebook supplies auth
selection, auth-chain and state checks, state resolution and redaction;
it takes event/state data rather than doing storage or network I/O.
(`api/engine/room/build.ts:49-80`, `api/engine/rulebook/index.ts:26-45`,
`api/engine/rulebook/types.ts:129-144`, `hooks/pre-commit:31-35`)

Authoring finalizes `origin` from the injected signer before content hashing,
version-specific redaction, signing and reference-id calculation. Local ingest
takes that signer's server explicitly, requires its signature entry, and
permits additional caller-verified signatures such as an invite countersignature.
(`api/engine/room/build.ts:296-326`, `api/engine/room/ingest.ts:320-358`)

Ingest checks the declared auth chain, authorization against state at the
event's own parents, then authorization against current published state for
soft failure. Rejected and soft-failed events remain stored but get no live
position or frontier membership. A soft-failed state event still has its own
after-state. Accepted children walk flagged ancestry when updating the frontier.
(`api/engine/room/ingest.ts:421-516`, `api/engine/room/ingest.ts:527-557`)

Room mutations are serialized by a room-id lock above the storage file gate.
Remote fetches run outside it; lifecycle is revalidated inside the locked
transaction. Remote batches use the shared ingest pipeline after verification
and bounded missing-event recovery.
(`api/engine/room/lock.ts:1-27`, `api/engine/room/remote.ts:1-17`)

## Two different state questions

State groups cache resolver output as snapshots or parent-relative deltas.
`materialize.ts` alone writes groups, entries, event-state refs, publications
and the current pointer. It writes a fresh snapshot when another delta would
exceed depth 32. A fingerprint deduplicates local groups; it is not a wire
agreement certificate.
(`api/engine/room/materialize.ts:1-12`, `api/engine/room/materialize.ts:71-127`,
`api/engine/room/materialize.ts:135-200`)

**State at an event** means its stored before/after refs. A single parent's
after-group supplies the child's before-state; multiple parents invoke the
rulebook resolver. An imported join or gap boundary is explicitly marked
`imported`; unknown state has null refs and provenance `none`, never a current
state fallback. Soft failure changes publication eligibility, not this question.
(`api/engine/room/build.ts:271-294`, `api/engine/room/ingest.ts:471-516`,
`api/engine/room/state.ts:107-153`, `api/engine/room/schema.ts:63-70`)

**State at a live cut** means the latest publication at or before a room
change position within a stay, or its opening group. The current pointer
represents the resolved live frontier. A server feed sequence is first
translated to `(stay, room change position)` before reading that publication.
These cuts need not equal an arriving event's own after-state.
(`api/engine/room/state.ts:155-188`, `api/engine/room/ingest.ts:579-621`,
`api/engine/client/read.ts:16-50`)

## Stays, history and recovery

A stay is an interval of local room participation. Stays and history are
explicit segment kinds, not numeric parity. Closing the last local member's
stay retains its frontier; a rejoin opens another stay. A remote join stores
its auth/state evidence without timeline positions, opens an imported state
boundary and ingests the join as live.
(`api/engine/room/segments.ts:18-26`, `api/engine/room/segments.ts:143-175`,
`api/engine/room/ingest.ts:717-741`, `api/engine/room/join.ts:370-431`)

Positions are `(segment, offset)` with one first owner per event. History
prepends below the existing minimum offset, preserving existing cursors.
Backfill verifies and authorizes parents before children, writes history
changes and event-state refs, and never publishes live state, queues delivery
or enters the live feed: history is never news.
(`api/engine/room/schema.ts:83-89`, `api/engine/room/segments.ts:1-12`,
`api/engine/room/history.ts:1-16`, `api/engine/server/project.ts:535-556`)

Remote recovery waits briefly, asks for missing events, then requests state
and events for gap tips within a batch budget. Remaining ungrounded events
become pending with waits; later arrivals re-run the shared pipeline. A zero
ungrounded lifetime drops them instead. Delayed redaction targets use waits
too, without rewriting the stored target PDU.
(`api/engine/room/remote.ts:1-17`, `api/engine/room/ingest.ts:758-848`,
`api/engine/room/ingest.ts:654-681`)

## Timestamp lookup and isolated history anchors

Client and federation `timestamp_to_event` routes share a room-owned indexed
search over accepted, grounded, positioned events with genuine state refs.
Directions are inclusive; each candidate passes the caller's existing user or
server visibility policy. Complete equal-timestamp buckets are dependency-ordered
through the stored prev DAG, with first-owner positions breaking branch ties;
remote depths never determine the answer. Candidate-to-candidate reachability
meets from both directions instead of walking every ancestor to genesis. Reads
fail explicitly with 503 above 10,000 equal-time candidates, 100,000 scanned
events, or a shared 100,000-unit causal read budget, rather than
returning a truncated or hidden result.
(`api/engine/room/{events,timestamp}.ts`, `api/engine/federation/serve.ts`)

On a local miss or unresolved history boundary, client lookup tries up to three
current ACL-eligible residents, oldest held membership first, with an eight-second
fetch deadline. Timestamp distance is not evidence of a complete history. Serving
federation lookup is local-only. A remote claim must match its fetched, verified
PDU's room, id, timestamp and direction, then pass the shared history importer's
auth and state checks. Key acquisition retains its transport's own request bound.
Failure retains an eligible local result; storage errors are not peer misses.
(`api/engine/room/timestamp-search.ts`, `api/engine/federation/fetcher.ts`)

A disconnected hit gets an `anchor` segment in the existing segment owner, not
an arbitrary prepend to a stay's connected history. Backward pagination fills
that anchor's own gap. Forward pagination imports bounded pages from held newer
boundaries and crosses actual positioned child edges, never an assumed owner
stay. Unavailable connections retain a resumable gap cursor. Shared visibility
uses proved later publication/opener ancestry for isolated anchors, not arbitrary
stay allocation; a pre-join anchor can acquire that proof through the same bridge.
Zero-limit context retains both pagination tokens. Positions and event-state refs survive
reopen. Import changes are history, never live news: sync/feed, notifications,
published state, extremities and delivery stay unchanged.
(`api/engine/room/{history,segments,state}.ts`, `api/engine/client/timeline.ts`)

## Room-first writes and server projection

The room transaction records its mutations and delivery destinations in
`changes`. After that transaction commits, an injected hook projects them
into the server file. Projection failure leaves the room write committed;
the next projection or startup rolls forward from its watermark.
(`api/engine/room/schema.ts:109-120`, `api/engine/room/ingest.ts:685-714`,
`api/engine/room/hooks.ts:21-48`, `api/engine/server/startup.ts:13-38`)

Projection writes a batch and advances its watermark in one server
transaction. Rows are idempotent on `(room, pos)`; outbox rows also include
destination. The server assigns global live-feed sequence numbers here.
It is durable truth for those numbers, delivery progress and user intent,
not a disposable file to rebuild from room events.
(`api/engine/server/project.ts:1-15`, `api/engine/server/project.ts:79-103`,
`api/engine/server/project.ts:589-597`, `api/engine/server/project.ts:678-700`)

Membership reconciliation compares published members with the server's
actual projected rows, including the imported opening of a new stay.
Changed opening memberships get that first live cut; unchanged rows keep
their sequence. Relations, search and redaction effects also belong to
server projection. Search normalizes NUL to space and lowercases indexed
body/name/topic text without altering the PDU.
(`api/engine/server/project.ts:602-662`, `api/engine/server/project.ts:701-730`,
`api/engine/server/project.ts:578-587`, `api/engine/server/project.ts:419-467`)

## Client reads and sync

Stored and inline sync filters share shape validation and pure matching across
room selection, timeline, state, presence, ephemeral and both account-data
streams. Denials win, empty lists exclude everything, and only `*` is special
in type globs. Senderless stream envelopes never gain a fabricated sender.
Selection and timeline visibility/ignore checks precede limits, while stream
cuts advance across excluded data. E2EE control streams and notification counts
are not content-filtered. Federation event format crosses the same viewer-aware
renderer as client format; `event_fields` may receive the spec-permitted superset.
(`api/engine/tenant/filters.ts`, `api/engine/syncfeed.ts`)

All client timeline rendering crosses one viewer-aware `renderEvent` boundary.
Its shared visibility policy requires accepted, grounded events; the viewer's
own membership events are visible without a qualifying join. Other events need
genuine event-state refs: after-state, plus before-state for history-visibility
transitions. Shared visibility, including unknown values, requires a qualifying
join at the event or later; publications can prove the later join without
replacing the event's own policy. Thread bundles filter children before
computing count, latest reply and participation.
(`api/engine/client/render.ts:19-30`, `api/engine/client/visibility.ts:6-62`,
`api/engine/client/render.ts:115-145`)

Relations share structural admission across live and historical projections:
accepted, grounded, same-room parents and children, valid string relationship
fields, no self-links or redacted children. A late parent is re-evaluated at read
time; redacting a parent does not detach its children. The viewer relation view
then excludes ignored senders and invisible children before count, latest,
participation and pagination. Thread lists order by the latest eligible reply.
The three relations routes decode messages/sync cursors directionally, support
`from`/`to`, and issue opaque room-bound continuation tokens. Explicit `recurse`
walks three levels before result filtering and reports `recursion_depth`; omitted
`recurse` omits the depth. Reads beyond the explicit traversal budget fail, rather
than claiming an incomplete walk is complete. Nested latest events inherit the
parent's serialization options, without recursively bundling threads.
(`api/engine/client/{relations,relation-view}.ts`, `api/engine/room/order.ts`,
`api/engine/server/{project,read}.ts`)

Paginated relation/thread order uses a room-owned derived causal height, then
first-owner positions and event ID as tie-breakers. Heights come only from held
prev edges, never remote PDU depth. Event insertion repairs indexed descendants
when a missing parent arrives; the room transaction commits graph and keys
together. Room schema v1 upgrades seed the index once without changing PDUs.
Subsequent reads fetch only candidate/anchor keys in bounded batches, independent
of the old room prefix, and filtering or adding an anchor cannot reorder the
remaining IDs. The shared room ordering module retains the nearby bidirectional
tie algorithm for non-paginated timestamp queries.

Ignored non-state messages share a presentation filter across client timeline,
context, search and standalone push readers. Renderers and relation views require
the viewer's tenant explicitly; neither uses the application singleton to read
ignore policy. State still reaches clients and original PDUs remain
unchanged. Both read-marker routes validate the event's room before persisting
`m.fully_read` through the account-data owner; it never enters the public/private read-receipt stream, changes unread
counts, or accepts a thread id.
(`api/engine/client/{ignored,render,search}.ts`, `api/engine/receipts.ts`)

`/sync` timeline visibility follows that same event-state policy. Its state
blocks and unsigned membership retain their separate publication-cut
contracts; `renderStateEvent` formats admitted state snapshots, including
imported evidence, rather than imposing timeline eligibility on them.
(`api/engine/syncfeed.ts:99-144`, `api/engine/client/render.ts:29-54`)

The token grammar is `s<e>_p<p>_t<t>_r<r>_a<a>`: events, presence, typing,
receipts and account data. Omitted suffix components parse as zero. Room
feed entries and out-of-band invite transitions share one durable event
allocator. Invites and knocks use one typed, revisioned `prejoin_memberships`
row per room/user. They never provision a room file or open a stay. A later
room membership publication supersedes OOB display/count truth at the shared
sequence cut. Federation prejoin state keeps the signed full create PDU;
validated client display strips it. Legacy malformed create hints are filtered,
while v12 requires a valid create tied to the room identity. Typing is ephemeral;
presence and receipts are server data, while
account-data stream markers belong to the tenant.
(`api/engine/client/tokens.ts:1-33`, `api/engine/server/stream.ts:1-52`,
`api/engine/typing.ts:1-48`, `api/engine/server/schema.ts:115-132`,
`api/engine/tenant/schema.ts:72-108`)

Receipts are keyed by room, user, public/private type and thread. Sync exposes
public receipts plus the viewer's private receipts; federation consumes only
public receipts. Thread identity survives both sync and federation, with
unthreaded receipts kept distinct from `main` and named threads.
(`api/engine/server/ephemeral.ts:165-264`, `api/engine/federation/ephemeral.ts:40-56`,
`api/engine/federation/edus.ts:157-188`)

Some client details are easy to overstate. `/messages` may omit `end` on a
nonempty, completed unfiltered walk. Alias listing also permits world-readable
nonmembers. User directory search covers visible local accounts, not remote
users. The v12 upgrade transformation sets tombstone power to 150 only if the
inherited value is below `state_default + 1`; 150 is not an unconditional floor.
(`api/engine/client/timeline.ts:228-240`, `api/engine/client/directory.ts:127-144`,
`api/engine/client/directory.ts:244-282`, `api/engine/client/upgrade.ts:65-77`)

## Federation and delivery

Client and federation public directories use one published-state metadata
serializer, including room types. Both filter `room_types` (with `null` for
untyped rooms) before counting and pagination. User-directory candidates include
unlisted world-readable rooms, while retaining the local-account scope.
(`api/engine/client/{directory,summary}.ts`)

`/room_summary` reads reuse that metadata and separate discovery
access: joined/invited users, public or supported knock rules, world-readable
history, or current membership in a restricted room's allowed rooms. Remote
summaries use signed federation hierarchy and are filtered again for the user;
inspection creates neither room participation nor peer-roster entries. Anonymous
summaries use held public, knockable or world-readable data only; remote summary
requests require authentication. Other v1 rooms and media routes stay protected
through the existing folder-level authentication placement.
`federation.discoveryservers` controls the server-attempt cap (default 3).
(`api/engine/client/discovery.ts`, `api/engine/room/restricted.ts`)

Remote discovery applies the shared summary schema's public default when
`join_rule` is omitted, as standard servers may do. Held private summaries always
serialize their explicit join rule.

Client space hierarchy walks valid, redaction-aware child links depth-first,
ordered by valid ASCII order, timestamp and room ID. Opaque five-minute sessions
retain the pending stack and visited rooms, bind user/root/depth/suggested filters,
and recheck access on every page. Unknown children use signed via discovery;
remote summaries are filtered again for the user, and remote inaccessible children
are not retried. Federation serves one held root and its immediate children only,
distinguishing known inaccessible children from unknown rooms. Neither endpoint
joins rooms or expands the peer roster. The layered `hierarchy` settings control
page sizes (50 default, 100 cap), optional depth cap (0 = unrestricted), session
lifetime/capacity and retained traversal-room budget. Exhaustion fails explicitly,
not with a falsely complete partial walk. Sessions expire on process restart.
(`api/engine/client/hierarchy.ts`)

Authenticated room `initialSync` and room-scoped `/events` preview held rooms
without joining or fetching history. Outsiders require world-readable state;
banned and forgotten readers are refused. Former joined members retain their
departure cut for both messages and state, not later publications; declining an
invitation does not grant private state. Initial messages use the shared local-only
timeline walk and chronological output, real pagination tokens, and only the
caller's room account data. Event polls arm listeners before reading, recheck
access, and clean up on cancellation or timeout. Layered `peeking.maxevents`
(default 50) and `peeking.maxtimeoutms` (default 30000) bound pages and waits.
(`api/engine/client/peeking.ts`)

Alias and profile discovery ask remote servers by default, including anonymous
requests, through signed, admission-gated federation. `federation.lookups=known`
restricts answers to held data; `none` disables remote lookup answers. Discovery
never adds a participation roster entry.
(`api/engine/federation/{discovery,gate}.ts`)

Federation has its own request-signature/admission boundary and per-version
event-signature verification. Keys are looked up by server and key id with
the required validity floor; failure to obtain or verify a key refuses the
event. Authenticated contact resets outbound backoff and wakes the queue.
(`api/engine/federation/auth.ts:32-135`,
`api/engine/federation/keyresolver.ts:17-46`)

Resident `/state` and `/state_ids` read the event's own before-state, including
imported boundaries; unknown state returns 404. Federation event/history
serving has a separate server-principal policy: return full or version-redacted
PDUs according to that server's visibility at the event. This is not the
client user's boolean timeline-visibility question.
(`api/engine/federation/serve.ts:32-54`, `api/engine/federation/serve.ts:70-94`,
`api/engine/federation/serve.ts:174-177`)

Joining verifies the returned snapshot and our join. A returned join must
recompute to our id; only its verified resident signature is merged into our
authored copy, retaining our signed content. Restricted authorization preserves
only the template's validated authorizer field over our own profile/reason,
and requires its resident signature; ordinary joins can keep our signed copy
alone. Required authorizer signatures cross the shared verification boundary
for live, recovered, history, snapshot and prejoin events. Snapshot sender
fallback never replaces the additional authorizer requirement. The pure
rulebook consumes verified input; it does not resolve keys under a room lock.
(`api/engine/room/join.ts:252-340`)

`room/restricted.ts` owns the decision to vouch, separate from DAG auth. It
reads current allowed-room membership outside the target write, then rechecks
its immutable stay/group revision before the locked target transaction. That
fresh eligibility read is the authorization point; later departure does not
retroactively revoke a join. Target state changes retry at most three times.
Only open allowed-room stays vouch for remote users, never archived snapshots.
The rulebook supplies versioned invite power, including v12 noncreator users.
No local authorizer or unknown eligibility can route a local user to another
resident. Candidate attempts are deterministic, capped at eight, with a
60-second scheduling budget and the transport's per-request deadline. A
resident remote-vouch response enters normal verified recovery in the existing
stay, never installs the returned snapshot over published state.

Explicit remote join candidates constrain the attempted servers. Automatic
invite/qualified-resident discovery is used only when no remote candidate was
supplied (including a request naming only our own server); a room-ID domain is
only a no-candidate fallback. This keeps an explicit failover refusal from
silently becoming a join through an unrequested peer.

Delivery begins with durable room intent, then idempotent projected outbox
rows. One worker per destination resumes pending work on startup. Batches
and URL-safe transaction ids are derived from pending rows; changed batches
get different ids. Frozen EDUs exist only in process memory and do not survive
restart; EDU-only sends are ephemeral, not durable retry jobs.
(`api/engine/room/ingest.ts:685-714`, `api/engine/server/project.ts:589-597`,
`api/engine/federation/sender.ts:1-18`, `api/engine/federation/sender.ts:331-344`,
`api/engine/federation/sender.ts:483-507`)

PDU expiry marks lapsed rows failed and records refusal in one server
transaction. Reject-invite jobs have no expiry. Knock attempts are journaled
before their network side effect and retry the same signed event; knock
retractions save their signed leave before delivery. Revision checks fence late
responses from newer invites/retractions/joins. Knock retry/retraction work uses
the configured refusal lifetime, retains expired work for operator review and
can be retried explicitly. Pruning an ambiguous attempt schedules compensating
leave rather than silently discarding the remote side effect. The sender's stop
latch prevents a new backoff sleep after stopping begins.
(`api/engine/federation/sender.ts:388-411`, `api/engine/federation/invites.ts:706-728`,
`api/engine/federation/sender.ts:359-371`)

### Room ACL admission

Room ACL admission reads current published room truth, not the received PDU's
parents or the server projection. The network-free room evaluator implements
case-insensitive whole-host globs, deny precedence, default-deny for a present
ACL, port-independent matching and IP-literal policy. Applied redaction effects
are read from the room change log. Storage errors never mean "no ACL".
(`api/engine/room/acl.ts`, `api/engine/room/changes.ts`)

Federation serving and membership use that owner; inbound transactions recheck
each PDU in the locked batch, so an accepted ACL change immediately affects
later traffic. Typing and each receipt room use the same room lock. Outgoing
requests carry explicit room scope, including `/event` recovery, and are checked
before discovery and again before dialing. Delivery to resident peers retains
the spec's recommendation even when a peer is denied; mixed frozen transaction
bodies and durable delivery obligations are not rewritten or discarded.
(`api/engine/federation/{acl,client,edus,joins,serve}.ts`, `api/engine/room/remote.ts`)

## Tenant data, storage and process lifetime

Room tags are atomic edits of the tenant's ordinary `m.tag` room account data,
not a second store. Own-user reads and deletes need no current join; additions
require an existing room membership. Tags and ordinary room account-data writes
wake sync and include their room even when no room event changed. Incremental
sync reads those rows between its account-data cuts; unchanged rows are omitted.
(`api/engine/client/tags.ts`, `api/engine/tenant/accountdata.ts`)

Hosted accounts are localparts under the configured homeserver's signing
identity. The tenant generates its key once and reloads it on reopen, keeping
its stored native name and key id. A newly generated key has a public-key-derived
id; existing ids are retained. Passwords use Argon2id PHC strings; access and
refresh credentials are stored only as SHA-256 digests.
(`api/engine/tenant/index.ts:337-401`, `api/engine/tenant/index.ts:51-62`,
`api/engine/tenant/users.ts:1-3`, `api/engine/tenant/users.ts:39-55`,
`api/engine/tenant/auth.ts:1-6`, `api/engine/tenant/auth.ts:17-48`)

Refresh rotation revokes the old access token but keeps the old refresh token
retryable until the replacement access or refresh token is used. Client send
and redaction retries are scoped to `(user, device, generation, endpoint, transaction id)`,
independent of token refresh; endpoint identity includes the send event type
or redaction target as well as the room.
(`api/engine/tenant/auth.ts:227-303`, `api/engine/tenant/txns.ts:1-52`)

The shared Matrix-id parser splits at the first colon, preserving a server
name's port. Local upload metadata remains tenant-owned; bytes live under
`media.root`. Uploads enforce the size bound while streaming to `.part`, then
rename the completed file. Generated media ids use the shared URL-safe encoder.
(`api/engine/ids.ts`, `api/engine/media.ts`, `api/engine/tenant/media.ts`)

`media/service.ts` owns authenticated remote demand and current origin admission,
including cache hits. Server schema v21 stores origin/media-id/variant metadata;
origin filenames are independent of a caller's response-only override. The
disk-cache owner deduplicates fills, bounds concurrency, syncs and renames a
unique unpublished part before metadata publication, repairs crash leftovers,
and leases served files against retention/quota cleanup. No network or disk
side effect runs inside a retryable transaction callback. Shared fills track
subscribers: one disconnect cannot cancel another, and the last disconnect
aborts the owned transfer, including queued fills. App shutdown closes the owner.
(`api/engine/server/media.ts`, `api/engine/media/cache.ts`)

Raw federation and JSON requests share signing, discovery, TLS and cancellation.
The HTTP/1 reader streams bounded chunks with sink backpressure; node TLS pauses
between reader requests. Media consumes exactly two multipart parts, validating
the final envelope before publishing bytes. Only a completed 404
`M_UNRECOGNIZED` permits legacy fallback, with `allow_remote=false`. External
Locations use CA-only HTTPS with checked/pinned addresses, no forwarded auth or
cookies, bounded redirects and one total deadline/byte budget. URLs are not
cache identity or persisted metadata. Legacy serving remains local-only.
(`api/engine/federation/client.ts`, `api/engine/net/http1.ts`,
`api/engine/media/{multipart,location,service}.ts`)

The shared thumbnail service serves local client, legacy-local and signed
federation routes. Remote variants fetch signed federation thumbnails before
bounded local validation/static generation. Cache identity includes format,
method, dimensions and animated flag. PNG/JPEG geometry/bytes are checked before
decoding; at most the configured number of workers hold compressed inputs and
pixel-bounded image buffers. ImageScript 3.20.2 runs off the main thread, with
termination on deadline/cancellation, and emits a fresh static PNG without
source metadata. Nothing decrypts attachment ciphertext.
(`api/engine/media/{thumbnail,thumbnail-worker,service}.ts`)

The storage layer owns native-library loading, file transactions and
maintenance. Startup checks the qualified Turso revision and patch set. Safe
creation applies the schema in a `.new` directory, closes/reopens, verifies,
syncs files, renames, then syncs the parent. Opens apply only explicitly
supported version steps in one store-owned transaction with the version
marker; unknown versions are refused. Tenant v3 upgrades to v4 preserve
identity and credentials while scoping devices to each user. A new device
incarnation gets a new generation, bound into tokens and transaction receipts.
Legacy v3 receipts remain archived when their ownership cannot be proved.
(`api/engine/store/index.ts:151-197`, `api/engine/store/build.ts:12-38`,
`api/engine/store/create.ts:18-21`, `api/engine/store/create.ts:104-165`)

Room/tenant handles acquire a pool lease per operation and release it in
`finally`; idle eviction cannot close leased files. At the configured log
threshold (default 4,120,000 bytes), the file gate pauses admission, drains
active transactions and checkpoints before reopening admission.
(`api/engine/store/index.ts:88-105`, `api/engine/store/pool.ts:118-154`,
`api/engine/store/pool.ts:250-300`, `api/engine/store/gate.ts:59-83`,
`api/engine/store/gate.ts:102-142`, `defaults/communico.toml:28-42`)

Write conflicts retry the entire transaction after rollback, with bounded
jittered backoff; other errors propagate. Transaction bodies must use only
their connection and attempt-local values, publishing effects after commit.
The bounded immutable-edge cache follows that contract: attempt overlays
merge only after a successful room transaction, and contain no database handles.
(`api/engine/store/db.ts:202-271`, `api/engine/room/edges.ts:1-23`,
`api/engine/room/index.ts:165-188`)

The process owns public Matrix HTTP, optional federation TLS and a private
admin Unix socket. Admin operations are versioned JSON POSTs calling engine
functions; socket ownership/mode checks and inode-checked cleanup protect the
local boundary. Tools use the running server, not direct file access. Whole-room
operator drop/purge records durable removal intent, distinct from event redaction.
(`main.ts:90-135`, `api/admin/index.ts:16-66`, `api/admin/index.ts:72-148`,
`tools/admin.sh:1-12`, `api/engine/room/operator.ts:55-134`)

Configuration layers shipped TOML, an optional overlay and environment leaves;
unknown nodes and wrong types are errors. Signals stop admission, drain all
listeners within the configured grace and close storage last. Unhandled
rejections log a fatal marker and allow at most two seconds for cleanup before
non-zero exit. See README for socket paths, certificate bootstrap and a
supervisor example.
(`api/engine/config.ts:1-5`, `api/engine/config.ts:135-165`,
`api/engine/config.ts:253-301`, `main.ts:20-42`, `main.ts:139-162`)

## Content reports

Admin report pages select IDs using stored UTF-8 byte sizes before hydrating
reasons or resolutions, in one read snapshot. The shared `server.maxrequestbytes`
setting is also the encoded page target (including worst-case JSON escaping).
The count limit still applies. A report larger than that target is returned
intact as a singleton, never truncated or skipped; continue with `next`.
Thus listing memory scales with the byte target or one oversized report, not
the count limit times the largest allowed request. Reasons have no field cap.

The shared Matrix request admission middleware bounds every non-upload body
before JSON validation, authentication or handler dispatch, including handlers
that ignore bodies. It checks declared size and counts actual streamed bytes;
Pathfinder memoizes accepted bytes for downstream consumers. The layered
`server.maxrequestbytes` setting defaults to Synapse's 200 x 64 KiB request
budget. The existing 413 renderer emits `M_TOO_LARGE`. Only the two upload
endpoints opt out through `mediaUpload` route metadata; their streaming media
owner enforces `media.maxbytes`. No report-specific reason cap is applied.
(`api/engine/body-limit.ts`, `api/endpoints/matrix/05-body.ts`)

The shared client report handler validates event/room/user report bodies before
delegating persistence to the server-owned reports table (server schema v22).
Event reports require current joined membership and a visible same-room event;
the room lock keeps admission ordered against local membership changes. Room
reports do not require membership. Existing local users can be reported without
shared rooms; unknown or nonlocal users receive a no-disclosure success response.
(`api/engine/client/reports.ts`, `api/engine/server/reports.ts`)

Reports store target identifiers, reporter, reason/score and resolution metadata,
never copies of event content. They are not room events, projections, sync news
or federation work. The private admin socket lists and resolves them through the
same owner; resolving retains the first resolution and does not moderate events.
(`api/admin/reports.ts`, `api/engine/server/schema.ts`)

## Scope and recorded evidence

The checked-in Complement baseline records a red conformance baseline, not
universal protocol correctness. Native checks and HTTP integration tests are
available through the current tasks. This document was verified by source
inspection and pointer checks, not a new runtime or conformance run.
(`complement/BASELINE.md:1-22`, `deno.json:7-18`)

Browser homeserver/native sync, home/VPS sync, store-image adoption,
announce digests, WebRTC/WebTransport and Model B remain parked/future work.
That does not demote the browser homeserver promise or choose its storage
engine. E2EE remains core product scope; current implementation status and
the distinction from these parked tracks are summarized in README.
(`README.md:15-20`)
