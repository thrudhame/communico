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

Remote recovery waits briefly and asks for missing events. Only pulled events
permit state/event recovery behind their missing parents, within a batch budget;
pushed events whose own parents remain unavailable return a per-PDU error. A
missing `events` field in a missing-events answer is an empty list, not malformed
JSON. Remaining ungrounded events become pending with waits; later arrivals
re-run the shared pipeline. A zero
ungrounded lifetime drops them instead. Delayed redaction targets use waits
too, without rewriting the stored target PDU.
(`api/engine/room/remote.ts:1-17`, `api/engine/room/ingest.ts:758-848`,
`api/engine/room/ingest.ts:654-681`)

Inbound and history boundaries share one event retrieval strategy: after
`/state_ids` and held-event deduplication, missing at least 10% of the required
events selects bulk `/state`. Sparse sets and incomplete/unavailable snapshots
use bounded `/event` reads. Only requested missing events with recomputed IDs
and verified room-version signatures/hashes enter the evidence pack; complete
boundary authorization and the original operation budgets still apply.
(`api/engine/room/boundary-fetch.ts`)

Recovery authorizes complete evidence graphs outside the mutation lock, reading
and inserting at most 32 evidence events per transaction. Every snapshot and
write revalidates the room change cut; concurrent ordinary writes can interleave
and invalidate prepared decisions. Staged evidence has no event-state refs,
positions or publications. Imported boundaries still enter live ingest whole,
with current lifecycle, ACL and authorization checks. Evidence dependent on live
candidates stays with their real verdict; a dependency tail larger than 32 leaves
the recovery unresolved, never a partial imported state.
(`api/engine/room/recovery.ts`)

One history operation shares an eight-second deadline, 128 network requests and
10,000 work units across its page and all state/auth boundaries. Forward bridges
share that budget across pages and peers. Exhaustion or cancellation leaves an
unresolved gap without partial publication; storage errors still propagate.
(`api/engine/room/history.ts`)

## Timestamp lookup and isolated history anchors

Client and federation `timestamp_to_event` routes share a room-owned indexed
search over accepted, grounded, positioned events with genuine state refs.
Directions are inclusive; each candidate passes the caller's existing user or
server visibility policy. Complete equal-timestamp buckets are dependency-ordered
through the stored prev DAG, with first-owner positions breaking branch ties;
remote depths never determine the answer. One shared ancestor DAG establishes
nearest candidate dependencies, stopping below the lowest candidate's indexed
local height instead of repeating pairwise walks or reading to genesis. Reads
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
Complete anchors with proved forward connections no longer count as gaps.
Failure retains an eligible local result; storage errors are not peer misses.
(`api/engine/room/timestamp-search.ts`, `api/engine/federation/fetcher.ts`)

A disconnected hit gets an `anchor` segment in the existing segment owner, not
an arbitrary prepend to a stay's connected history. Backward pagination fills
that anchor's own gap. Forward pagination imports bounded pages from held newer
boundaries and crosses actual positioned child edges, never an assumed owner
stay. Unavailable connections retain a resumable gap cursor. Shared visibility
uses proved later publication/opener ancestry for isolated anchors, not arbitrary
stay allocation; a pre-join anchor can acquire that proof through the same bridge.
An isolated anchor's visibility uses one bounded descendant walk and indexed,
cut-qualified publication selection. Budget exhaustion is an explicit 503, not
partial permission. Membership content is reused per visibility read. Room schema
v3 upgrades existing files with selective event/change and redaction-target JSON
indexes, preserving the earliest applied redaction effect.
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

Client state disclosure has one admission owner, separate from raw state reads
and event serialization. A grant names the room, viewer and exact publication
or event-state snapshot. Joined/authorized snapshots retain old and imported
state keys; a declined invitation alone never grants a private snapshot.
Without snapshot permission, only individually visible state survives. Published
participation history fixes the real departure boundary: a later ban, declined
reinvitation or current join cannot disclose a different private interval.
Sync uses a separate client state-delivery owner to decide whether an admitted
old snapshot is a reusable baseline. Stripped prejoin display is not full-event
delivery. A new participation interval, including a departure/rejoin hidden
between polls or an imported new stay, resets selected full state in ordinary
and sliding sync. Continuous joins keep snapshot deltas; profile-only changes
do not reset them. Ordinary stream tokens remain stateless, not filter-history
receipts: arbitrary filter expansion still uses explicit `full_state`.
State/members, context, lazy
messages state, search state/profiles and initialSync share this boundary;
search hydrates the admitted departure snapshot rather than current room state.
Discovery explicitly admits only its existing summary/child-link state types
and retains its separate access gate. The common event serializer is private;
timeline events and state snapshots reach it through their respective admission
owners. Prejoin display keeps its existing stripped/provenance ceiling.
(`api/engine/client/{state-admission,state-delivery}.ts`, `client/{render,state}.ts`,
`api/engine/room/state.ts`)

Native simplified sync validates the deployed MSC4186 request
dialect separately from ordinary sync. Tenant schema v19 owns issued connection
positions, scoped to user/device generation and connection ID. A response's
immutable snapshot is not consumed by a retry of its input; revision fencing
rejects stale in-flight publishers. Completed responses retain at most the
input and one successor. Device deletion removes both connection and position
rows. A no-position replacement fences stale publishers immediately, but only
successful publication retires the previous connection and issued positions.
Startup and new admission prune expired connections; seven idle days,
per-device/tenant capacity and snapshot bytes are layered `slidingsync` settings.
Connection persistence never acknowledges or reads the to-device inbox;
protocol coordination and inbox publication have separate owners.
(`api/engine/sliding-sync/request.ts`, `api/engine/tenant/sliding-sync.ts`)

The simplified-sync list owner captures server membership/activity cuts and
tenant DM/tag/ignore values before selecting windows. Filters compose before
counts and inclusive ranges; overlapping requests union required state and take
the largest timeline limit. Activity is received live-feed order, frozen at
departure for nonmembers. Metadata reads use publication cuts or saved prejoin
display, not current private state. Plain joined-room windows and encryption-only
requests hydrate no room files or timelines. List eligibility is independent
from authorization of explicit historical room subscriptions.
(`api/engine/sliding-sync/lists.ts`, `api/engine/server/read.ts`)

Both sync protocols share visibility-before-limit live-window selection. Sliding
room payloads retain independent state and timeline delivery cuts, expand history on limit growth and
reload after a real participation interruption. Required-state and display
metadata use the same captured admission grant, including actual departure
ceilings and lazy membership IDs. Prejoin payloads use stripped display only;
saved invitation departures never provision a room. Room assembly does not own
authentication, polling or position publication.
Zero timeline limits do not acknowledge unseen events. Saved departures follow
the requested timeline limit and required-state selection independently; an
explicitly empty state selection is never overridden. DM removal resets the
last delivered value for prejoin rooms as well as joined rooms.
(`api/engine/client/{sync-window,state-delivery}.ts`, `api/engine/sliding-sync/rooms.ts`)

Sliding inbox delivery reuses the tenant's durable queue, acknowledgment and
bounded issued-delivery receipts. Opaque receipts are scoped to the protocol and
connection as well as the device generation; a room-list position, forged token
or another connection cannot acknowledge unseen keys. Zero-size pages issue no
deletion authority, count/byte limits preserve the tail, and an evicted receipt
replays rather than consumes data. Ordinary sync remains a direct consumer of
the same owner. Polling inspects the same issued acknowledgment boundary without
consuming it, so received pages do not make every encryption poll immediate.
(`api/engine/tenant/todevice.ts`)

Account-data delivery captures the global/selected room bodies, push rules and
their shared maximum in one tenant transaction. Ordinary sync consumes that
same capture; slow rendering cannot read a later body under an older cursor.
Sliding room selection supplies independent per-room account cuts. Bounded
set-based reads capture membership and pending-prejoin room data; only explicit
capture entries, including empty results, authorize advancing a room cut.
Global-only scopes do no room-body reads. Receipt
reads accept an explicit captured maximum and share the wire formatter with
ordinary sync. Single-event receipt maps follow MSC4102's unthreaded-wins
collision behavior, without removing the independently stored thread slots.
(`api/engine/tenant/accountdata.ts`, `api/engine/server/ephemeral.ts`)

Room extensions select the union of admitted named list windows and actual
subscriptions, not arbitrary requested room IDs. Their account/receipt/typing
cuts advance only for selected rooms. First or expanded receipt windows include
timeline-target marks plus the viewer's own marks, with private rows scoped to
their viewer.
Incremental receipt captures read from each room's own delivered cut; initial
and expanded timeline windows retain full receipt snapshots.
Typing snapshots copy values and counters before rendering;
ordinary sync shares that capture, and a process epoch invalidates persisted
sliding typing cuts after restart. Empty stops remain real updates.
(`api/engine/sliding-sync/extensions.ts`, `api/engine/typing.ts`)

The E2EE extension reuses the existing all-shared-room device-list audience and
tenant OTK/fallback status. No-pos requests have empty device-list deltas;
disabled extensions do not read or advance their independent cuts. Later enable
reads from the connection's retained baseline, not an unrelated room-list cut.
Unchanged status envelopes are not poll updates, while key-pool changes are.
(`api/engine/sliding-sync/extensions.ts`)

Final sliding publication runs only after rendering: one tenant transaction
validates the lease, applies the connection-scoped inbox acknowledgment, selects
its bounded page and commits the successor. Stale/oversized snapshots and aborts
roll back all those effects. A disabled inbox extension performs no inbox work.
(`api/engine/sliding-sync/delivery.ts`)

Ordinary and sliding sync share the same stream-wait owner. Listeners are armed
before capture; projection, event, tenant and ephemeral notifications are only
hints to recapture, never proof of relevance. One absolute deadline survives
unrelated writes. Polling sweeps typing expiry at the existing bounded cadence;
abort, capture failure and successful return all remove listeners and timers.
(`api/engine/sync-wait.ts`)

The authenticated deployed unstable simplified-sync POST composes these owners.
Per-device connection serialization precedes lease acquisition; independent SDK
room-list and encryption connections do not block each other. Relevance compares
requested windows/configuration, admitted payloads and enabled extension data,
not constant SYNC operations or fresh position tokens. Counts come from the same
notification buckets as ordinary sync; count-only read changes can update a
zero-timeline room. Request cancellation reaches both polling and atomic final
publication. The versions response advertises `org.matrix.simplified_msc3575`;
clients discover native support without a proxy URL or an SDK override.
(`api/engine/sliding-sync/index.ts`, `api/engine/sliding-sync/lock.ts`)

Stored and inline sync filters share shape validation and pure matching across
room selection, timeline, state, presence, ephemeral and both account-data
streams. Denials win, empty lists exclude everything, and only `*` is special
in type globs. Senderless stream envelopes never gain a fabricated sender.
Selection and timeline visibility/ignore checks precede limits, while stream
cuts advance across excluded data. E2EE control streams and notification counts
are not content-filtered. Federation event format crosses the same viewer-aware
renderer as client format; `event_fields` may receive the spec-permitted superset.
(`api/engine/tenant/filters.ts`, `api/engine/syncfeed.ts`)

Messages, context and search use that same validated room-event filter rather
than independently dropping malformed fields. Messages applies the complete
type/sender/room/URL predicate before its result limit, retaining only scan-cut
anchors across excluded prefixes. Filter limits can further reduce a page.
Contiguous history is read and hydrated in 32-event segment pages; the shared
walk still stops at imported or isolated boundaries before crossing their DAG.
Indexed event fields reject unrelated events without deserializing their PDUs.
Ordinary sync normalizes omitted presence to online, rejects malformed booleans
and numeric parameters, and returns full-state requests immediately even with
a since token and positive timeout.
(`api/engine/client/{timeline-request,sync-request,timeline}.ts`)

Search has one normalized operation contract and one keyset pagination owner for
rank and recent ordering, including room and sender scopes. Equal ranks retain a
deterministic sequence/event tie-break. Global and per-group continuations name
the last real result in their scope, including on a terminal nonempty page as in
Synapse. Following a terminal cursor yields an empty page with no further token.
Search rejects an explicit zero result limit. Using a group token keeps subsequent global
continuations in the same group. Multiple matching indexed keys
still produce one event result. Known search keys, context, grouping and boolean
fields are validated before selection rather than silently discarded.
Group order is assigned once on insertion, without rescanning existing groups.
(`api/engine/client/{search-request,search-page,search}.ts`)

Joined-member summaries retain Synapse's explicit null display/avatar strings
when absent and preserve empty strings when present. The OpenAPI response guard
is test-only: its explicit compatibility table documents this nullable-profile
exception and the terminal-search-page contract without changing pinned schemas
or rewriting runtime responses. Other field types remain checked.
(`tests/spec-contract.ts:responseCompatibility`)

Matrix JSON middleware and adapters share one body decoder. Its generated
operation metadata preserves the tagged requestBody.required flags. Absent bytes
are an empty object for optional bodies and, as in Synapse/Complement, for required
body schemas that accept an empty object (including join). Required fields still
reject before dispatch; malformed nonempty JSON, whitespace, UTF-8 and non-object
roots never gain omission semantics. The all-operation native guard compares
every generated flag and empty-object decision with the pinned schemas, and
prevents adapters from bypassing the shared decoder. Binary media retains its
streaming owner. Response-schema compatibility remains exclusively test-time.
(`api/engine/operation-body.ts`, `tools/spec-contracts.py`, `tests/operation-body.test.ts`)

Membership and redaction adapters validate the common optional string reason
before dispatch, including idempotent joins. State format and member filters
validate their enumerations without turning malformed intent into a different
projection. Federation profile fields follow their own explicit enum. Signed
one-time/fallback key objects require signature maps before any pool publication;
this is structural validation, not a new cryptographic verification requirement.
(`client/{membership-request,state-request}.ts`, `tenant/e2ee.ts`)

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
The same owner bundles reference IDs and the most recent valid edit, selected by
origin timestamp then event ID. State, annotation and replacement parents have no
bundles. Replacements retain full event shape, never mutate original content,
and require the original sender/type and non-state events (cleartext edits also
require new content). Redacted originals omit replacements; redacted edits fall
back to the prior revision. Latest thread replies retain their own edit/reference
bundles. Local annotation duplicate admission reads accepted, grounded room truth
and its applied redaction log under the existing authoring lock, before a new
transaction receipt is prepared; retry receipts reconcile before admission.
Room schema v5 adds the target/sender/type/key annotation expression index for
that locked lookup, preserving existing PDUs and redaction indexes on upgrade.
Direct reference bundles remain complete even above the recursive traversal
budget; only recursive graph expansion applies that budget.
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

`/sync` timeline visibility follows that same event-state policy. Timeline
selection hydrates bounded newest-first feed pages and renders only the requested
visible window plus one lookahead. New-join presence comes from the captured
membership projection, not a second walk over room history. Search profiles use
the same viewer-aware state rendering as other state consumers.
Its state blocks and unsigned membership retain their separate publication-cut
contracts; `renderStateEvent` formats admitted state snapshots, including
imported evidence, rather than imposing timeline eligibility on them.
With `use_state_after=true`, joined/left rooms send `state_after` instead of
`state`, even when empty. It is the resolved publication at the response end
or departure cut, including updates already in the timeline. Initial/full-state
responses carry the full cut; incremental responses carry its delta from since.
Filtering and lazy member loading apply after cut selection. Later publications
cannot leak across the captured response token.
Imported before-state boundaries stop live sync windows rather than splicing
older feed rows across missing remote history. Filtering or visibility omissions
alone do not set `limited`; eligible limit trimming and real gaps do. A newly
joined client's global since cut does not establish continuity with older room
history; a retained pre-since prefix remains a paginatable gap. Untrimmed
windows retain their captured end token, including for historical membership
reads. Limited windows use real room cursors before their first returned event;
backward pagination follows the missing predecessor into an isolated
history anchor even when the gap is inside a stay. These imports remain history,
never new feed events. Lazy state retains timeline sender memberships, mandatory
own membership on initial/full-state/new-join responses, and changed memberships
across limited incremental gaps, for both state forms.
(`api/engine/syncfeed.ts:99-144`, `api/engine/client/render.ts:29-54`)

The token grammar is `s<e>_p<p>_t<t>_r<r>_a<a>`: events, presence, typing,
receipts and account data. Omitted suffix components parse as zero. Room
feed entries and out-of-band invite transitions share one durable event
allocator. Invites and knocks use one typed, revisioned `prejoin_memberships`
row per room/user. They never provision a room file or open a stay. A later
room membership publication supersedes OOB display/count truth at the shared
sequence cut. One prejoin owner emits signed, version-correct full PDUs for
federation invite/knock state, including create, and stripped events for client
display. Held sync uses its membership publication cut; unsigned membership
hints use that event's after-state, never later current state. Those client
forms apply ordinary redactions and viewer-aware erasure before stripping.
OOB hints come only from their revisioned, validated prejoin record. Full hints
retain privately computed source IDs, never remote-asserted IDs. Once a room is
held, sync, notifications and push share the saved-hint display owner: accepted
sources use the current redaction/erasure projection; unidentified legacy hints
are pruned by the room-version rules instead of exposing uncheckable content.
The shared display decision applies the room-version redaction algorithm to the
saved event itself. Its source shape ceiling is recursive, preserves saved
values, never restores omitted fields, and drops incompatible nested shapes.
Private provenance is never included in client hints. Legacy malformed create hints are filtered,
while v12 requires a valid create tied to the room identity.

OOB rejection intent persists a real locally signed departure membership,
separate from the later federation make_leave result (server schema v23).
The caller's leave reason, including an empty string, belongs to that durable
intent and is copied into the separately signed federation departure. Remote
templates cannot replace it; frozen retries retain the same signed leave.
Left-room state/state_after contains only the full departure event, never
stripped saved hints with fabricated identities. Older pending intents acquire
that event once under their revision owner. Saved invite/knock hint redaction
and unsigned notification projection keep their existing shared owner.
The common full-event formatter also retains the requested federation/client
format for OOB departures. Inclusive pagination cuts explicitly identify the
event to return, not the next event's numeric slot.

Typing is ephemeral; presence and receipts are server data, while
account-data stream markers belong to the tenant.
(`api/engine/client/tokens.ts:1-33`, `api/engine/server/stream.ts:1-52`,
`api/engine/typing.ts:1-48`, `api/engine/server/schema.ts:115-132`,
`api/engine/tenant/schema.ts:72-108`)

Receipts are keyed by room, user, public/private type and thread. Sync exposes
public receipts plus the viewer's private receipts; federation consumes only
public receipts. Thread identity survives both sync and federation, with
unthreaded receipts kept distinct from `main` and named threads.
Each durable slot retains a whole set of event extremities, never an arbitrary
representative. One mark commits one stream position and all notification-read
effects atomically; ordinary/sliding sync expand its extremities without losing
the shared thread/type identity. Outbound EDU coalescing replaces whole marks.
Server schema v24 upgrades existing scalar targets to singleton arrays while
preserving their stream positions and timestamps.

Sync captures member and visible-receipt sets with two set-based queries inside
the existing server transaction for maxima, memberships and notification counts.
Long-poll relevance checks notification-change existence, not the full count map.
Notification listing filters the shared retention cutoff without owning deletion.
Push-rule bodies and action updates are validated by their shared tenant writer.

Typing admission is serialized with server membership writes; completed room
projection reconciles retained typing before notifying consumers. Leave, ban,
imported resets and outsider stops clear retained entries and publish a stop.
Receipt ingress rejects malformed thread metadata instead of treating it as
unthreaded. Unknown roots retain their identities, with admission capped at 100
per room/user/receipt type; known slots remain writable. Pending notification
references admit at most 256 per room/user, refusing additional writes atomically
without evicting existing references. Malformed or capacity-refused inbound
receipt entries do not suppress later valid entries; storage failures still do.
Unknown-thread and pending-reference capacity refusals both use 429, while a
membership refusal remains a separate not-joined outcome. Failed admissions
publish neither a receipt nor a sequence advance.
(`api/engine/server/ephemeral.ts:165-264`, `api/engine/federation/ephemeral.ts:40-56`,
`api/engine/federation/edus.ts:157-188`)

Some client details are easy to overstate. `/messages` may omit `end` on a
nonempty, completed unfiltered walk. Alias listing also permits world-readable
nonmembers. User directory search covers visible local accounts, not remote
users. The v12 upgrade transformation sets tombstone power to 150 only if the
inherited value is below `state_default + 1`; 150 is not an unconditional floor.
Create and upgrade share version-aware creator-list validation. Malformed
upgrade bodies, versions and v12 creator lists fail before replacement-room,
alias, push-rule or tombstone effects; supported older versions ignore the
v12-only creator field. Valid duplicates and the upgrader's own ID are retained.
(`api/engine/client/timeline.ts:228-240`, `api/engine/client/directory.ts:127-144`,
`api/engine/client/directory.ts:244-282`, `api/engine/client/upgrade.ts:65-77`)

## Federation and delivery

Remote response schemas share one optional-field boundary: JSON null for a
declared optional field is decoded as absence unless that field's specification
gives null meaning. Required fields and wrong non-null types still fail. Decoded
projections omit absent fields without rewriting signed key JSON, opaque event
content or unknown extension values. This includes membership/delivery envelopes,
directory/profile/hierarchy metadata, key documents, remote E2EE records and
completed Matrix error responses. It does not relax authenticated client request
decoding or required transaction/EDU fields.
(`api/engine/net/json.ts:optionalField`, `tests/peer-response-optionals.test.ts`)

The shared outbound TLS dialer lets CA trust finish normal chain and hostname
validation in the handshake. Only pinned/key-is-name trust reads certificate
material afterwards, requesting the leaf alone and checking its key before
writing HTTP bytes. It does not rebuild a legacy certificate chain per request.
(`api/engine/federation/dial-node-tls.ts`)

Client and federation public directories use one published-state metadata
serializer, including room types. Both filter `room_types` (with `null` for
untyped rooms) before counting and pagination. One operation decoder validates
known query/body fields without turning malformed values into defaults. Network
selection distinguishes native, all and a named bridge instance; with no bridges,
a named instance has no rooms, not the native list. Conflicting all/instance
selectors are rejected. Local cursors are validated by their local owner;
directory pages retain Synapse's 100-room local cap. Federation GET normalizes
omitted/zero limits as no caller limit, distinct from client and POST defaults;
the serving cap still applies and continuation tokens retain the remaining rooms.
Omitted publication visibility
means public. User-directory candidates include
unlisted world-readable rooms, while retaining the local-account scope.
(`api/engine/client/{directory,directory-request,summary}.ts`)

Ordinary authenticated clients can read third-party discovery independently of
optional producers: protocols is an empty object, mapping queries are empty lists,
unknown protocol metadata is not found, and account 3PID discovery has an empty
`threepids` list. Required mapping query parameters remain required. These reads
do not implement bridges, application-service writes or identity-server actions.
Profile capabilities include matching legacy display-name and avatar flags.
(`api/engine/client/thirdparty.ts`, client v3 discovery adapters)

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
lifetime/capacity, per-user retained cursor capacity (100 by default, against
1000 shared), and retained traversal-room budget. Repeated continuations reuse
identical saved cursors without allocating another slot, while rechecking access.
Exhaustion fails explicitly,
not with a falsely complete partial walk. Sessions expire on process restart.
(`api/engine/client/hierarchy.ts`)

Authenticated room `initialSync` and room-scoped `/events` preview held rooms
without joining or fetching history. Outsiders require world-readable state;
banned and forgotten readers are refused. Former joined members retain their
departure cut for both messages and state, not later publications; declining an
invitation does not grant private state. Initial messages use the shared local-only
timeline walk and chronological output, real pagination tokens, and only the
caller's room account data. Event polls arm listeners before reading, recheck
access using only history_visibility at the captured cut, and clean up on
cancellation or timeout. Only initialSync materializes full state. Layered `peeking.maxevents`
(default 50) and `peeking.maxtimeoutms` (default 30000) bound pages and waits.
(`api/engine/client/peeking.ts`)

Account erasure records durable tenant intent with held rooms' publication
boundaries. Client event/state/previous-content rendering and federation history
share one serve-time policy: prior event visibility survives, including shared
history acquired before the boundary and world-readable events. New private
history readers receive version-pruned copies. Retries retain the first boundary;
PDUs and auth graphs remain unchanged, with no federation erasure signal or
synthetic redaction. Search excludes pruned content before counts and ranking.
Account-data, filter, push-rule and credential owners clear non-event data in the
same tenant transaction as deactivation. Existing append-only change streams
remain intact. (`api/engine/erasure.ts`, `api/engine/client/account.ts`,
`api/engine/tenant/erasure.ts`)

Persisted UIA flows use one expiry boundary for lookup and stage completion.
The layered `uia.sessionseconds` defaults to Synapse's 48 hours; creation prunes
expired rows and `uia.maxsessions` bounds retained flows (10000 default). Capacity
refuses new flows with 429, never evicts an active continuation. No IP or user-agent
metadata is retained. (`api/engine/tenant/uia.ts`)

The tenant profile owner assembles legacy user columns and additional JSON field
rows, and validates whole-profile byte limits inside the write transaction.
Legacy setters use the same owner, avoiding independent size budgets. Public
client and federation queries expose the assembled profile; room creation,
joins and profile fan-out use only the legacy display/avatar projection.
Custom null is a stored value, while DELETE removes the row. Deactivation clears
both sources. Profile fan-out attempts every joined room after saving the global
profile. Partial failure returns 503 with failed_rooms, keeps failed membership
content unchanged, and preserves successes in later rooms.
Operator diagnostics pair each failed room with its propagation cause; the
client response still contains only the existing failed-room IDs and status.
(`api/engine/tenant/profiles.ts`, `api/engine/client/membership.ts`)

Alias and profile discovery ask remote servers by default, including anonymous
requests, through signed, admission-gated federation. `federation.lookups=known`
restricts answers to held data; `none` disables remote lookup answers. Discovery
never adds a participation roster entry. Closed-mode lookup refusals do not
populate the actionable pending queue or displace real participation requests.
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

Federation request decoders retain required arrays and integer envelopes instead
of accepting malformed empty requests. Missing-event selection filters declared
depth before its result limit, without trusting that depth as DAG order or a walk
boundary. Absent make_join versions negotiate only version 1. The cache-only
notary signs a held document only when its validity meets every requested floor;
omitted floors use one current-time cut. Transaction timestamp/array validation
precedes replay publication, so malformed requests cannot cache empty success.
Notary POST selects all held hits in one cache query and signs only eligible
documents, with no network fetch or per-miss transaction. Missing-event reads
walk lightweight native graph metadata and hydrate only selected results; an
indexed no-candidate check avoids a walk when no held depth can qualify.
Low-depth predecessors still expand, and the existing independent 100000-event
failure boundary never becomes a silently truncated successful answer.
(`federation/{history-request,notary-request,transaction-request}.ts`)

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

That scheduling budget bounds when another candidate may start, not a new total
join deadline. Synapse likewise retries destination callbacks with per-request
transport bounds. Ordinary nonrestricted admission reads only its member and
join-rule keys; it does not hydrate unrelated room state or an auth closure.

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

Local encryption policy belongs to the shared room authoring gate, not individual
client routes or Matrix remote-event auth. In encrypted rooms the independent
`encryption.allowunencryptedreactions` toggle (default true) admits only
`m.reaction` content containing one `m.relates_to` object with exactly
`rel_type: "m.annotation"`, string `event_id` and string `key`. Extra fields,
other relations and custom call-reaction types follow `allowunencryptedmessages`.
Keys have no emoji/length restriction: Matrix exposes them regardless of outer
encryption. Redaction and verification exceptions are unchanged.
Direct sends, durable prepared retries, already-built local PDUs and delayed
scheduling/delivery share this classification. Current locked state/policy is
rechecked before ingest; completed receipts still replay before policy admission.
Remote validity and state-event behavior do not change.
(`api/engine/room/encryption-policy.ts`, `room/ingest.ts`, `delayed-events.ts`)

The tenant's delayed-event owner stores schedules, send-transaction receipts and
prepared signed PDUs (schema v20). The app owns scheduler startup and draining
shutdown. Due selection is only a hint: claiming a command rechecks its current
deadline, so a heartbeat restart fences stale selection. Disabling new scheduling
preserves existing durable delivery obligations.

Delayed writes compose the existing room LocalSubmission contract: persist exact
signed bytes before room ingest, reconcile by event ID on retry, then finish the
receipt. No tenant transaction encloses a room transaction. Before preparation,
the room authoring lock protects current membership and publication-history
cancellation checks; ordinary ingest retains current authorization/encryption.
Other-sender changes to the selected published state key cancel pending work,
including resolved/federated changes and changes followed by an own-user update.
Own updates preserve a pending call leave. An app reopen resumes overdue work
and reconciles a crash after room commit without publishing a duplicate event.
(`api/engine/delayed-events.ts`, `tenant/delayed-events.ts`, `room/state.ts`)

The access logger has one URL disclosure owner. It omits every query string and
redacts credential-bearing path values, including delayed-event bearer IDs and
third-party invitation state keys, before both the head and completion lines.
Malformed/miss paths cross the same boundary. The real routing/authentication
request is unchanged; this adds neither log lines nor IP/user-agent collection.
(`api/engine/access-log.ts`)

Encrypted backup ciphertext, per-room entry sizes and per-version restore bytes
share one tenant transaction. PUT capacity checks use those exact UTF-8 JSON
totals, including escaped identifiers and separators, instead of scanning all
retained sessions. Session caps still span every version for a user. Tenant v18
upgrades backfill the aggregates once in bounded pages without changing payloads
or etags. Device replacement/deletion also publishes changed public signing views;
reliable EDU packing preserves their queue order under byte pressure. Shared
device recovery has subscriber-owned cancellation, not first-caller ownership.
(`api/engine/tenant/{key-backup,backup-accounting,devices}.ts`,
`api/engine/federation/{device-lists,sender}.ts`)

OpenID credentials live in the tenant's separate hashed-token table (tenant
schema v15), never in the client access/refresh tables. Issuance and userinfo
check the active account in the owning transaction, enforce the configured
expiry and survive reopen. Deactivation clears the credentials. The only new
unsigned federation route is `openid/userinfo`, which authenticates its own
bearer; sibling federation routes retain signature admission.
(`api/engine/tenant/openid.ts`)

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
Registration allocates a unique localpart when omitted. Inhibited registration
creates the account without a device or session; disabled guest intent is refused,
never converted to ordinary registration. Login's initial device name applies
only to a new device, not an existing device rename. Operation-specific session,
password and ephemeral decoders validate known scalar types before UIA or effects;
malformed typing cannot become a stop or advance the typing stream. Room creation
distinguishes missing fields from explicit null values before applying defaults.
(`tenant/session-request.ts`, `client/ephemeral-request.ts`, `room/create.ts`)
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
name's port. Event-context user references share historical-ID validation:
legal non-surrogate Unicode, controls other than NUL, and empty localparts are
accepted without normalization, with the 255-byte identifier bound. Power
levels, additional creators and restricted authorizers use this contract;
new local account naming and non-event device-list policy remain separate.
Local upload metadata remains tenant-owned; bytes live under
`media.root`. The shared local-media publisher owns admission, bytes and metadata
for direct uploads, reserved PUTs and preview images. It serializes each media ID,
rechecks ownership/pending status, streams within the size bound to a private
0600 `.part`, fsyncs the open file, closes and renames it, then fsyncs the parent
before publishing uploaded metadata. Competing reserved PUTs cannot replace
acknowledged bytes; failed publication leaves the reservation retryable.
Generated media ids use the shared URL-safe encoder.
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
Maintenance runs at startup, after fills and on the configured interval, not on
cache hits. A fill's serving lease is acquired before cleanup can evict bytes.
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

The HTTP representation boundary handles informational heads, HTTP field and
chunk grammar, and gzip/deflate/Brotli content decoding before any consumer.
Encoded, decoded and intermediate bodies retain the request's byte limit.
Unsupported codings and malformed HTTP/MIME/JSON are protocol failures, not
connection failures. Only network primitives classify transport faults; sink
and store errors remain local, and caller cancellation retains its identity.
Public Matrix outcome rendering maps typed upstream failures once.
MIME receivers ignore bounded preambles/epilogues and accept transport padding,
quoted parameters, folded MIME fields and headerless media parts. The Matrix
adapter separately requires exactly two parts and object metadata. Binary/7bit/
8bit transfer encodings preserve octets; other transfer encodings are explicitly
unsupported rather than cached as original bytes. No cache entry is published
before complete envelope validation. Remote filenames use RFC8187 UTF-8 language
tags and preserve quoted spaces before the existing filename sanitization.
(`api/engine/net/{upstream-error,fields,json,http1}.ts`,
`api/engine/media/{multipart,service}.ts`)

Federation JSON successes require the JSON media type and fatal UTF-8 decoding;
well-known discovery explicitly ignores the media type as required by its schema,
while retaining the same fatal UTF-8, JSON and endpoint validation.
Empty or malformed replies cannot become null success. Endpoint consumers still
own the decoded root/schema. Outgoing transactions validate the required PDU
verdict map before acknowledging their frozen durable batch or recording peer
success. Malformed 2xx keeps delivery pending and retries the same transaction;
local signing/storage faults are not cached as peer failures. Completed HTTP
refusals keep their separate status and Matrix-error provenance.
(`api/engine/federation/{client,responses,sender}.ts`)

Endpoint envelopes validate required object/array and scalar shapes without
coercing IDs or inventing missing graph edges. Join, leave and knock templates
negotiate explicit supported versions; omitted legacy versions never become v11.
Recovery may treat typed peer failures and cancellation as unavailable evidence,
but local signing/store faults propagate. Protocol diagnostics retain the original
cause internally while console/JSON projections exclude raw response snippets;
completed HTTP refusals keep the remote body separately from their safe message.
(`api/engine/federation/{fetcher,responses,invites,knocks}.ts`,
`api/engine/net/upstream-error.ts`, `api/engine/room/deps.ts`)

Server-key and notary schemas decode every entry before persistence without
adding optional fields or rewriting signed validity. The seven-day effective
expiry is stored beside the intact signed document and remains tied to its
acquisition time on cache reads. Only typed peer failures enter negative key
memory; local storage/signing faults and cancellation retain their identity.
Policy-refused key changes have separate acquisition backoff. The store's stable
server database capability owns acquisition memory shared by every key-store
view; accepting or forgetting a server clears both memories immediately.
Admin decisions also invalidate active lookup generations. Network acquisition
runs outside the per-name mutation lock; publication rechecks its generation
inside that lock, so obsolete work cannot restore forgotten keys, decisions or
negative memory. A later contact never joins the superseded acquisition.
Event, prejoin, history and join consumers distinguish peer verification refusal
from a local resolver fault, which never becomes missing evidence or resident
failover. Matrix wire Base64 uses the standard alphabet and accepts the optional
padding recommended by the specification; the legacy stored-data decoder remains
separate. Remote content hashes require valid SHA-256 binary material and compare
decoded bytes. Equivalent padding never causes redaction, and verification never
normalizes the signed hash representation or opaque room-version reference IDs.
(`api/engine/federation/{key-document,keys,witness,keyresolver,auth}.ts`,
`api/engine/room/verify.ts`, `api/engine/signing-primitives.js`)

Remote E2EE schemas are separate from authenticated-upload validation. Device
snapshots require keys per device; only that endpoint accepts Synapse's deployed
null optional signing keys. Queries, claims, snapshots and EDUs share wire key,
signature and Base64 checks before publication. Malformed claimed keys never
publish and claims are never retried. Peer failures retain typed unavailable or
backoff behavior; local admission, cache and persistence faults propagate instead
of becoming peer outages. Subscriber cancellation does not charge peer backoff.
(`api/engine/{e2ee-wire,e2ee-remote,e2ee-public-signing}.ts`,
`api/engine/client/e2ee.ts`, `api/engine/federation/device-lists.ts`)

Alias lookup and joining share one directory response decoder. Profile and
hierarchy consumers validate endpoint schemas before returning data or applying
access policy, preserving extensions, unset profile nulls and the public default
for omitted join rules. Read-only discovery supports signed GET and POST bodies
without adding participation records. Inbound transactions validate required
metadata and PDU/EDU containers before persistence; malformed ephemeral entries
cannot become typing stops, invented receipt timestamps or default presence.
Unknown local handler failures propagate without caching transaction success.
(`api/engine/federation/{discovery,discovery-response,peer-json,transactions,edus}.ts`)

X-Matrix authorization parses quote-aware comma lists, token/quoted parameter
values and unique names before signature verification. Discovery validates
Matrix server names, preserves redirect queries, follows HTTP(S) using the
matching transport, and caches according to Cache-Control and response age.
Only classified peer failures fall back; local CA faults and cancellation
propagate. SRV selection uses priority and RFC2782 weighted ordering, recognizes
an unavailable service, and retains alternate targets and A/AAAA answers.
Address families resolve concurrently; a usable answer is dialable immediately.
Later SRV targets remain unresolved until connection failover begins, then race
the failed target's remaining families so a stalled answer cannot block a healthy
backup. Deferred address reads share caller cancellation and the dialer's total
deadline.
Dial failover stops before the first HTTP write: completed or uncertain requests,
decoder failures and sink failures cannot replay on another address. Delegated
Host and TLS identities never acquire the SRV target's port.
(`api/engine/federation/{xmatrix,server-name,well-known,resolve,dial-node-tls}.ts`)

Push verdicts cross the same fatal UTF-8, JSON media-type and endpoint-schema
boundary before a target can be rejected or delivery acknowledged. Only typed
peer failures schedule retry; local faults and cancellation retain their identity.
URL previews follow only defined HTTP redirect statuses. HTML metadata uses the
HTML parser and encoding-sniffing standards (BOM, transport, meta, fallback),
not text matches inside comments, scripts or quoted attributes. XHTML retains
XML namespace, case and well-formedness rules. Neither parser executes scripts
or resolves external entities. Existing SSRF, byte and image-codec limits remain.
(`api/engine/push/{transport,sender}.ts`, `api/engine/preview/{guard,og,index}.ts`)

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
integer validation applies to native query results as well as parameters;
nonfinite REAL results fail in the native binding before JSON serialization can
turn infinities into a SQL-null lookalike.
out-of-range integers fail before callers receive rounded database values. Safe
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
`finally`; idle eviction cannot close leased files. The shared pool queue owns
only synchronous metadata changes. Per-file reservations serialize opening,
initialization and detached closing without holding that queue; identity listing
retains physical incarnations while reading outside it. Shutdown drains accepted
listings, reservations, leases and retention before native lifetime ends.
At the configured log
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
Outbox destination selection applies to queued work and status-only peers alike;
omitting it lists all destinations. CLI retry and expiry times retain their real
past/future direction, including retained expired work.
(`main.ts:90-135`, `api/admin/index.ts:16-66`, `api/admin/index.ts:72-148`,
`tools/admin.sh:1-12`, `api/engine/room/operator.ts:55-134`)

Store startup takes an exclusive nonblocking ownership lock before creating,
sweeping or opening its root. Its stable sibling file, `.<store-basename>.communico.lock`, is
retained after shutdown; another owner refuses before it can modify a live
store. Store shutdown also drains admitted snapshots before releasing ownership.
(`api/engine/store/{index,ownership}.ts`, `native/turso-ffi/src/lib.rs`)

The internal offline restore lifecycle shares that lock, rejects symlink or
overlapping roots and refuses nonempty store or media targets without explicit
replacement. Private candidates live beside each target, even when the two roots
use different filesystems. A fully synced undo journal precedes no-replace
renames; replacement keeps both old roots. Startup refuses an unfinished journal
before creating or opening a root. An explicit offline retry checks the recorded
directory identities and rolls back the entire original pair before preparing a
new candidate; unknown/tampered identities refuse without moving either root.
Candidate failure before publication removes only owned staging. The engine
coordinator composes this lifecycle with validation, sanitation and the report;
the explicit offline CLI invokes it without opening the app.
(`api/engine/store/{restore,ownership,index}.ts`)

Private restore candidates have a separate store-owned database lifecycle:
preflight all file paths, check full identities/integrity, apply only supported
migrations, then expose transaction-scoped capabilities without startup hooks or
workers. It records original and migrated schema versions and closes/drains
capabilities before promotion. Tenant sanitation composes the consuming-key,
inbox-receipt and sliding-position owners in one transaction: purge every restored
OTK/fallback pool, publish each affected pool status, clear old inbox deletion
receipts and expire both sliding connections and positions. Public signing keys,
credentials, encrypted session backups and retained inbox messages are unchanged.
The offline coordinator composes these owners with the recovery epoch/report
boundary before promotion, without opening the app.
(`api/engine/store/candidate.ts`, `api/engine/tenant/restore.ts`)

Server schema v28 adds a persistent restore recovery identity and report marker
after the facade journal, pairing and runtime-identity migrations.
Ordinary sync tokens retain their legacy wire form until the first restore, then
carry that identity. A different identity resets the entire sync baseline before
inbox acknowledgment or long-polling, even after numeric streams catch up. Both
ordinary sync and `/keys/changes` invalidate the current complete device audience
on that boundary. Room pagination can still read the token's event cursor; it
does not apply sync recovery semantics. A private candidate's report is written
0600 and fsynced before its digest completes the server marker. App startup checks
the marker, file digest and report identity before creating any app worker or
serving; missing, incomplete or modified reports refuse startup.
(`api/engine/server/recovery.ts`, `api/engine/backup/report.ts`,
`api/engine/client/{tokens,device-lists}.ts`, `api/engine/{app,syncfeed}.ts`)

Within one recovery epoch, ordinary sync bounds future durable stream numbers to
their owning server/tenant allocator ceilings before polling, as Synapse does.
Typing remains process-local and is not numerically clamped. A repaired baseline
never becomes an issued inbox acknowledgment: changing any numeric field cannot
manufacture deletion authority by matching an older real receipt. Parsing tokens
for room pagination remains storage-neutral and does not apply these repairs.
(`api/engine/client/tokens.ts`, `api/engine/server/stream.ts`, `api/engine/tenant/streams.ts`,
`api/engine/syncfeed.ts`)

Private tenant recovery rebases user-device allocators above both their archived
maximum and a fresh microsecond-clock anchor, then appends immutable reset intents.
Normal tenant roll-forward projects those behind retained reliable work using the
same full-resnapshot owner as subscription activation. Frozen envelope bytes, UUIDs
and old source identities stay unchanged. Subsequent updates chain from the new
anchor; new subscriptions, including empty accounts, use it too. Numeric rebasing
does not establish what an unseen peer once observed: `prev_id:[]` is the actual
resnapshot contract. Private server recovery invalidates learned remote-device
completeness/causal memory and retries without deleting keys or trust decisions.
The offline coordinator composes these owners before completing the report.
(`api/engine/tenant/changes.ts`, `api/engine/server/{device-federation,remote-devices}.ts`)

Restore work inspection uses query-only captured/candidate capabilities, never
sender or scheduler APIs. Domain owners inventory every retained delayed command
(including overdue, prepared and completed reconciliation state), outstanding
send receipts, tenant reliable intents/projection lag, server PDU/EDU and frozen
transaction identities/digests, join/knock/retraction work, queued pushes/badges
and unprojected room delivery intent. Keyset reads have no row-count ceiling;
reports omit message/key/PDU bodies. The report disclosure owner describes the
post-cut RPO, reviving old credentials, missing private keys and possible repeated
external effects. This inventory is not an extra operator approval gate; workers
resume normal semantics only after the completed durable report boundary.
(`api/engine/backup/work.ts`, `api/engine/{room,tenant,server}/restore-work.ts`)

The internal store snapshot owner retains physical file incarnations, opens and
normalizes inactive/over-cache sources and acquires checkpoint retention outside
common admission and the pool metadata queue. At the admission fence it drains
transactions/lifecycle changes, revalidates the final inventory and pins native
MVCC reads together. Retired but not yet unlinked files remain in the cut. SQL
export then copies schema, explicit rowids and bounded keyset pages into private
standalone targets while ordinary writes continue. Engine-private MVCC metadata
is regenerated, not copied as application truth. Each completed export releases
its source immediately; checkpoint retention defers initiation rather than
blocking committing writers. The file gate is the sole checkpoint owner; native
automatic checkpointing is disabled. Removal waits outside common admission,
and the Store drains all accepted maintenance before shutdown. The common pause
is measured, not deadline-limited. Completed targets use fsync and no-replace
publication, with private destination-side copying across filesystems. This
primitive exports databases, not media or deployment configuration by itself.
(`api/engine/store/{admission,db,export,index,pool,gate,files}.ts`)

The internal format-1 bundle manifest records logical identities, native/schema
provenance, the measured cut, secret disclosures and exact payload inventories.
Its sealer hashes and syncs payloads before creating a private completion file;
the reader refuses missing/extra entries, symlinks, invalid paths and mismatched
sizes/hashes without opening or migrating archived databases. Plaintext and
encrypted payload digests are separate. This metadata primitive alone is not
the whole-server backup/restore command.
(`api/engine/backup/manifest.ts`)

The optional bundle cipher uses standard GnuPG AES256 OpenPGP, disabled in the
shipped `backup` settings. It checks the private passphrase file and executable
before the cut, streams secrets through stdin and bytes through private 0600
files, verifies GnuPG's integrity status and the manifest's plaintext digest,
and cleans up only its own temporary GnuPG home/agent. Plaintext staging is not
secure erasure; the running backup and offline restore commands compose it.
(`api/engine/backup/encryption.ts`, `defaults/communico.toml`)

Captured-database inspection opens and upgrades only store-owned private scratch
copies, checks integrity and full file identities, and never invokes app startup
or workers. Domain audits check room DAG/state references, signing-key pairs,
allocator/source heads, projection references and watermarks, prepared/completed
send receipts and projected reliable delivery. Projection lag and the completed
room-removal crash window remain valid. The uploaded-media inventory includes
inactive tenants and excludes pending reservations. Full scans use keyset batches
without a row-count ceiling. Both backup and offline restore compose these audits.
(`api/engine/store/inspect.ts`, `api/engine/backup/{audit,checks}.ts`,
`api/engine/{room,tenant,server}/backup-audit.ts`)

The internal bundle producer captures deployment inputs before the running-store
cut, audits private database copies, copies only uploaded local media, and
preserves the original operator overlay, effective non-secret environment settings
and explicitly referenced Matrix/facade TLS/CA files. A present protected pairing
bootstrap is retained; a missing consumed bootstrap is valid. Private-file policy
and passphrase exclusion inspect the descriptor actually copied, through the same
pinned regular-file owner used by passphrase capture.
Portable deployment mappings record each original config node and bundled file.
Environment-sourced TURN credentials remain external; the encryption passphrase
source is never bundled. Optional encryption removes only owned plaintext staging
after encryption succeeds. The manifest-last seal and storage-owned no-replace
publication expose only the complete bundle. GnuPG uses a live directory-fd alias
for its private home/agent, so long bundle paths do not become socket paths. This
engine producer is paired with offline restore through the operator commands.
(`api/engine/backup/bundle.ts`, `api/engine/store/index.ts`)

The offline engine restore reads and verifies the complete manifest/inventory,
checks native/schema compatibility and copies/decrypts only private candidates.
It migrates and audits DB identities/source references, checks the uploaded-media
inventory, sanitizes consuming keys and delivery boundaries, rebases device streams
and invalidates learned device completeness. Real job inventories and RPO warnings
are fsynced into the report and bound into the candidate marker before closing
candidate DB lifetimes and promoting both roots. The immutable bundle is never
opened as a running store or migrated in place. Replacement preserves prior roots.
Portable generated configuration uses the same Matrix name and signing identity,
new storage/media paths and bundled TLS/CA mappings; explicit target overrides
win, but environment credentials remain external. The original effective/overlay
files are retained for provenance. Operators must fence the old installation
before serving the same identity on another machine; a local ownership lock cannot
fence another host. The offline CLI calls this owner, never app startup.
(`api/engine/backup/{restore,deployment}.ts`)

`./communico backup` / `deno task backup` resolve the destination at the caller
and invoke `/v1/backup` over the existing versioned private socket. That adapter
calls the running store's bundle owner. The client has no FFI or TCP permission
and no backup duration deadline. `./communico restore` / `deno task restore`
invoke the offline owner with native/file access and optional GnuPG subprocesses,
but no network permission. Their JSON results name the bundle or generated
configuration/report and retained replacement roots; detailed restore inventory
stays in the durable report. The normal start task permits `gpg`/`gpgconf` for
encrypted backup. Public Matrix listeners never mount either admin operation.
(`api/admin/backup.ts`, `tools/{backup,restore,admin-client}.ts`, `deno.json`)

Configuration layers shipped TOML, an optional overlay and environment leaves;
unknown nodes and wrong types are errors. Signals stop admission, drain all
listeners within the configured grace and close storage last. Unhandled
rejections log a fatal marker and allow at most two seconds for cleanup before
non-zero exit. See README for socket paths, certificate bootstrap and a
supervisor example.
(`api/engine/config.ts:1-5`, `api/engine/config.ts:135-165`,
`api/engine/config.ts:253-301`, `main.ts:20-42`, `main.ts:139-162`)

## Discovery, TURN and whois

Public client/support well-known responses read explicit layered settings and
share the root CORS middleware, independently of federation admission. Missing
client URL or all support fields yields 404; identity discovery is optional.
Support contact addresses are individual role-qualified entries, not paired lists.
(`api/engine/wellknown.ts`, `defaults/communico.toml`)

TURN credential discovery uses the authenticated user, configured TTL and URIs.
A shared secret takes precedence over static credentials: expiry seconds and
full user ID form the username; HMAC-SHA1 with padded standard base64 forms the
password. No external request, credential storage or TURN server is involved.
Incomplete configuration or zero TTL returns an empty object.
(`api/engine/turn.ts`)

MatrixRTC discovery reads one `matrixrtc.livekitserviceurl` setting, empty/off
by default. The shared owner supplies legacy well-known `rtc_foci` and the
authenticated unstable MSC4143 transports registry; versions advertises the
feature only when configured. The external authorization service owns LiveKit
credentials and SFU selection and uses the existing Matrix OpenID flow. This
server neither proxies LiveKit tokens nor runs the SFU. Client well-known still
requires its explicit homeserver URL. (`api/engine/matrixrtc.ts`)

Global push-rule reads share `tenant/pushrules.ts:rulesetFor`. Whois authorizes
self or the exact configured `admin.users` entry before checking target locality
or reading data. One tenant transaction reads devices and active access-token
sessions; no token identifiers, IPs, user agents or last-seen data are exposed or
newly recorded. Unknown local users have no devices, like Synapse's response.
The private Unix admin boundary remains separate.
(`api/engine/tenant/whois.ts`)

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

The public `/versions` route lists v1.1-v1.16 individually. The cumulative
[requirement checklist](MATRIX-VERSIONS.md) retains the tagged endpoint inventory,
explicit exclusions and executable consumer contracts, including inherited
sync continuity, OOB departure and lazy-membership obligations. Its guard checks
route handlers and executes the listed suites; the red Complement baseline
alone neither grants nor removes an advertised label. Creation-policy flags
remain independent of API version labels.

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
