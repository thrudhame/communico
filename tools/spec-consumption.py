#!/usr/bin/env python3
"""Expand ownership bindings into an exact request-consumption ledger.

Bindings retain the existing focused consumer contracts. Mechanical decoder
flow analysis in tests/spec-decoder.ts covers the remaining routed parameters;
there is no manual per-node semantic-review completion gate.
The checked-in expansion freezes every request
node and its complete schema, so adding a node requires a fresh review, not a
wildcard match. Reproduce with --check after generating spec-contracts.py.
"""
import argparse
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Reviewed unavailable modules: 23 exact operations / 153 exact request nodes.
# Their entire request is refused before any action, so nested field semantics
# are not independently decoded. Pin the complete reviewed schema/prose set;
# a new exclusion or field must not acquire this disposition by inheritance.
EXCLUDED_REQUESTS_SHA256 = "ca7a652e8a6306a3e9514053449084c9629f7f58eeb6785583e8ee3183c92deb"
# Exact selected schema/prose nodes reviewed below, independent of the generated
# ledger. Regeneration alone cannot approve a changed type/default/enum/prose.
REVIEWED_REQUESTS_SHA256 = "1d86c27a7e05993e1d196d4323d21c80cbde8abc07b43128ef49d081da6d82d5"


def binding(decoder, owner, suite, cases, disposition="honored", note="", reviewed=False):
    return dict(decoder=decoder, owner=owner, disposition=disposition,
                proofs=[dict(suite=suite, case=case) for case in cases], note=note, reviewed=reviewed)


def reviewed_bindings():
    bindings = {}

    def add(domain, families, decoder, owner, suite, cases, **kw):
        for family in families.split():
            bindings[f"data/api/{domain}/{family}.yaml"] = binding(
                decoder, owner, suite, cases, **kw)

    def cs(families, decoder, owner, suite, *cases, **kw):
        add("client-server", families, decoder, owner, suite, cases, **kw)

    def ss(families, decoder, owner, suite, *cases, **kw):
        add("server-server", families, decoder, owner, suite, cases, **kw)

    cs("account-data", "api/engine/json-middleware.ts", "api/engine/tenant/accountdata.ts",
       "http-client-data", "account data: all owner checks and server-controlled types, room scope isolation")
    cs("account_deactivation password_management", "api/engine/tenant/uia.ts", "api/engine/client/account.ts",
       "http-account", "A4: change password — one-shot UIA, old pw dies, caller token kept, logout_devices default/false",
       "A6: deactivate — flows include m.login.password; wrong pw 401 M_FORBIDDEN; right pw 200; later login 403")
    cs("admin", "api/engine/tenant/whois.ts", "api/engine/tenant/whois.ts", "http-small-endpoints",
       "whois permits self with no recorded connections and refuses other users")
    cs("administrative_contact", "api/engine/client/thirdparty.ts", "api/engine/client/thirdparty.ts",
       "http-operation-directory", "empty producers retain authenticated discovery and read contracts")
    cs("authed-content-repo content-repo", "api/engine/media/thumbnail.ts", "api/engine/media/service.ts", "http-media",
       "M1/M2: authenticated and legacy downloads preserve bytes, verbatim type and stored headers",
       "M4: create, pending 504, owner-only PUT, overwrite 409, both downloads byte-equal",
       "M3: both config routes advertise a number and retain auth")
    cs("banning inviting kicking leaving joining knocking", "api/engine/client/membership-request.ts",
       "api/engine/client/membership.ts", "http-operation-membership",
       "valid and empty reasons reach membership and redaction events")
    cs("capabilities", "api/endpoints/matrix/_matrix/client/v3/capabilities/get.ts",
       "api/endpoints/matrix/_matrix/client/v3/capabilities/get.ts", "http-operation-directory",
       "profile capability compatibility fields match enabled profile actions")
    cs("create_room", "api/engine/room/create.ts", "api/engine/room/create.ts", "http-room-write",
       "createRoom: presets, explicit default power levels, override merge and trusted invitees",
       "createRoom: initial state/name/topic order, local invites, aliases and version validation")
    cs("cross_signing", "api/engine/e2ee-signing.ts", "api/engine/client/cross-signing.ts", "http-e2ee-cross-signing",
       "first set, exact retry, UIA replacement and private key visibility",
       "structure, crypto and collisions reject atomically in both directions")
    cs("device_management", "api/engine/tenant/uia.ts", "api/engine/tenant/devices.ts", "http-account",
       "A1: login honors device_id + display name; GET/list/PUT; unknown → 404",
       "A1: DELETE device — bodyless 401 (session/flows/params), wrong pw 401 M_FORBIDDEN, right pw 200, token dead")
    cs("directory list_public_rooms", "api/engine/client/directory-request.ts", "api/engine/client/directory.ts",
       "http-room-directory", "aliases: public resolve, Unicode, duplicates/syntax/domain, list access, delete power and canonical repair",
       "directory: public GET/protected POST, chunk shapes, search, visibility toggles and pagination")
    cs("event_context message_pagination", "api/engine/client/timeline-request.ts", "api/engine/client/timeline.ts",
       "http-room-read", "messages: five-part/bare stream tokens, bounds, c-token paging, filtered end, lazy members and r0",
       "context: split, zero/default limit, filter not on pivot, state at last event, v12 id and redaction rendering")
    cs("filter", "api/engine/tenant/filters.ts", "api/engine/tenant/filters.ts", "http-client-data",
       "filters: store/get verbatim, validation, owner isolation and missing filter")
    cs("key_backup", "api/engine/client/key-backup.ts", "api/engine/tenant/key-backup.ts", "http-e2ee-key-backup",
       "all granularities, isolation, opaque rooms and ordered replacement reach the HTTP consumer",
       "version tombstones, numeric latest, immutable algorithm and metadata-only etag",
       "validation and configured budgets reject atomically without changing etag or ciphertext")
    cs("keys", "api/engine/tenant/e2ee.ts", "api/engine/client/e2ee.ts", "http-e2ee-keys",
       "upload -> another user queries exact signed material and display metadata",
       "overlap/conflict atomicity, FIFO, concurrent consuming claims and fallback retry")
    cs("list_joined_rooms", "api/engine/client/room.ts", "api/engine/client/room.ts", "http-membership",
       "join/invite/leave/kick/ban/unban: validation, reasons, idempotency and authorization")
    cs("login registration", "api/engine/tenant/session-request.ts", "api/engine/tenant/users.ts", "http-session",
       "r0 and v3 login adapters issue usable device-bound tokens through the same session owner",
       "registration availability, validation before UIA, inhibit_login; login/logout and logout/all")
    cs("logout refresh whoami", "api/engine/tenant/auth.ts", "api/engine/tenant/users.ts", "http-refresh-token",
       "refresh tokens: issue, rotate, revoke-old, same-device whoami")
    cs("notifications", "api/engine/client/notifications.ts", "api/engine/client/notifications.ts", "http-notifications",
       "would-have-notified history, highlights and stable exclusive pagination without pushers")
    cs("old_sync peeking_events room_initial_sync", "api/engine/client/peeking.ts", "api/engine/client/peeking.ts", "http-peeking",
       "initialSync previews held world-readable rooms without joining and exposes only caller account data",
       "room events resume, long-poll without lost wakeups, recheck access and respect timeout/cancellation")
    cs("openid", "api/engine/tenant/openid.ts", "api/engine/tenant/openid.ts", "http-openid",
       "own-user issuance, bearer-only userinfo, purpose separation and revocation")
    cs("presence typing", "api/engine/operation.ts", "api/engine/server/ephemeral.ts", "http-ephemeral",
       "typing starts/stops/expires, has no room_id, does not leak, and is per-user",
       "presence joins fan out both ways; status/set_presence validation and relevant wake")
    cs("profile", "api/engine/client/profile.ts", "api/engine/tenant/profiles.ts", "http-profile-fields",
       "one public profile supports arbitrary JSON, explicit delete and legacy fields without membership leakage",
       "avatar and timezone strings remain opaque while non-strings are rejected")
    cs("pusher", "api/engine/tenant/pushers.ts", "api/engine/tenant/pushers.ts", "http-client-data",
       "pushers: upsert, omission of optional profile_tag, no token disclosure, kind null deletes")
    cs("pushrules", "api/engine/tenant/pushrules.ts", "api/engine/tenant/pushrules.ts", "http-pushrules",
       "pushrules: CRUD + ordering + enabled/actions + server-controlled 405s",
       "existing push rules honor placement and before alone owns precedence")
    cs("read_markers receipts", "api/engine/receipts.ts", "api/engine/server/ephemeral.ts", "http-thread-receipts",
       "unthreaded/main/two threads and both receipt types survive sync without overwriting")
    cs("redaction", "api/engine/client/membership-request.ts", "api/engine/client/write.ts", "http-operation-membership",
       "valid and empty reasons reach membership and redaction events")
    cs("relations threads_list", "api/engine/client/relations.ts", "api/engine/client/relation-view.ts", "http-relations",
       "relations round-trip opaque pages and accept sync/messages from/to bounds on every route",
       "recursive traversal filters results, not intermediates, and reports requested recursion depth",
       "thread lists order by eligible latest reply, paginate and derive participation before counting")
    cs("report_content", "api/engine/client/reports.ts", "api/engine/server/reports.ts", "http-reports",
       "event reason and score are optional; private admins can read stored submissions",
       "room reports do not require membership; user reports do not require shared rooms")
    cs("room_event_by_timestamp", "api/engine/client/timestamp.ts", "api/engine/room/timestamp.ts", "http-timestamp",
       "inclusive directions, causal ties, actual timestamps, visibility and strict input")
    cs("room_send room_state", "api/engine/json-middleware.ts", "api/engine/client/write.ts", "http-room-write",
       "state routes: both depths, trailing slash, content/event shape, idempotency and prev_content",
       "txn: repeat/content/token/device/room scope; redaction receipt and read-time projection")
    cs("room_summary", "api/engine/client/discovery.ts", "api/engine/client/summary.ts", "http-room-discovery",
       "room summaries share published metadata and enforce user or anonymous access without joining")
    cs("room_upgrades", "api/engine/client/upgrade.ts", "api/engine/client/upgrade.ts", "http-room-directory",
       "upgrade: six creator/PL cases, v10/11/12 predecessor+tombstone, alias move, permission/version errors, rule migration")
    cs("rooms", "api/engine/client/state-request.ts", "api/engine/client/state.ts", "http-operation-membership",
       "state format and membership enums are validated without changing their valid meanings")
    cs("search", "api/engine/client/search-request.ts", "api/engine/client/search.ts", "http-operation-search",
       "explicit search keys, scope, context and state reach their consumers",
       "terminal nonempty pages have valid cursors while zero limits advertise no progress",
       "rank consumes every continuation once and ends after the empty terminal page",
       "recent consumes every continuation once and ends after the empty terminal page",
       "rank room_id continuation stays in its group and has an honest end",
       "rank sender continuation stays in its group and has an honest end",
       "recent room_id continuation stays in its group and has an honest end",
       "recent sender continuation stays in its group and has an honest end")
    cs("space_hierarchy", "api/engine/client/hierarchy.ts", "api/engine/client/hierarchy.ts", "http-hierarchy",
       "hierarchy walks stable depth-first pages, binds tokens and rechecks access",
       "unheld hierarchy children use signed via discovery and re-filter user access without joining")
    cs("support wellknown", "api/engine/config.ts", "api/engine/config.ts", "http-small-endpoints",
       "well-known client and support are explicit public settings with CORS")
    cs("sync", "api/engine/client/sync-request.ts", "api/engine/syncfeed.ts", "http-sync",
       "initial, incremental and full_state; global tokens; account data; revoked sync token",
       "state_after uses the publication end, retains timeline state, and obeys filters and departure")
    cs("tags", "api/engine/tenant/accountdata.ts", "api/engine/client/tags.ts", "http-tags",
       "tags share atomic account data and incremental sync, including concurrent writes")
    cs("third_party_lookup", "api/engine/client/thirdparty.ts", "api/engine/client/thirdparty.ts", "http-operation-directory",
       "empty producers retain authenticated discovery and read contracts",
       note="An empty provider set has no matches; protocol metadata is a resource miss, not a fabricated Protocol.")
    cs("third_party_membership", "api/engine/client/membership-request.ts", "api/engine/client/membership.ts",
       "http-operation-disabled", "disabled conditional producers never publish successful writes",
       disposition="module disabled/rejected", note="Identity-server invitation is not implemented; no normal Matrix invitation is manufactured.")
    cs("to_device", "api/engine/tenant/todevice.ts", "api/engine/client/todevice.ts", "http-todevice",
       "durable send, wildcard snapshot, scoped retries and issued-cut acknowledgments")
    cs("users", "api/engine/client/directory.ts", "api/engine/client/directory.ts", "http-room-directory",
       "user directory: global profile names, shared/public rooms, self exclusion and limits")
    cs("versions", "api/endpoints/matrix/_matrix/client/versions/get.ts", "api/endpoints/matrix/_matrix/client/versions/get.ts",
       "http-client-data", "versions stays public, capabilities stays protected, discovery absent per Addendum B")
    cs("voip", "api/engine/turn.ts", "api/engine/turn.ts", "http-small-endpoints",
       "TURN authenticates and returns empty configuration",
       "TURN returns static or expiring shared-secret credentials, secret wins")
    ss("backfill", "api/engine/federation/history-request.ts", "api/engine/federation/serve.ts", "http-operation-federation",
       "missing-event depth applies before the result limit, inclusively, without changing DAG ordering",
       "backfill requires v and strictly decodes limit")
    ss("content_repository", "api/engine/media/thumbnail.ts", "api/engine/media/service.ts", "http-remote-media",
       "HTTP federation media: signature required, local upload served as exact multipart bytes, never a foreign proxy")
    ss("event_auth events", "api/engine/federation/serve.ts", "api/engine/federation/serve.ts", "http-federation-history",
       "state/ids/event/auth/backfill/missing preserve wire shape, boundaries, caps and order",
       "auth closure recurses, excludes seed and later unrelated state")
    ss("invites-v2", "api/engine/federation/invites.ts", "api/engine/federation/invites.ts", "http-federation-membership",
       "invite v2: validate, countersign and persist an out-of-band invite")
    ss("joins-v1 joins-v2 knocks leaving-v1 leaving-v2", "api/engine/federation/joins.ts", "api/engine/federation/joins.ts",
       "http-federation-membership", "make_join: template fields; incompatible version/domain/room/ban/invite errors",
       "send_join v2: validation, merged signatures, snapshot and forwarding excludes joiner",
       "send_join v1 and make/send_leave v1/v2 preserve wrappers and membership effects",
       "knock routes authenticate the origin, validate membership and return prejoin wire state")
    ss("keys_query", "api/engine/federation/notary-request.ts", "api/engine/federation/keydoc.ts", "http-operation-federation",
       "notary honors explicit/default floors and validates all nested criteria")
    ss("keys_server version wellknown", "api/engine/federation/keydoc.ts", "api/engine/federation/keydoc.ts", "http-federation-keys",
       "our key document and deprecated key-id path are signed and public",
       "version, misses, wrong methods and well-known match the old contracts")
    ss("openid", "api/engine/tenant/openid.ts", "api/engine/tenant/openid.ts", "http-openid",
       "own-user issuance, bearer-only userinfo, purpose separation and revocation")
    ss("public_rooms", "api/engine/client/directory-request.ts", "api/engine/client/directory.ts", "http-federation-queries",
       "publicRooms: signed GET/POST, search, pagination and truthful network selection")
    ss("query", "api/engine/operation.ts", "api/engine/client/directory.ts", "http-federation-queries",
       "query/profile: local fields, unset nulls, malformed/domain 400, unknown 404",
       "query/directory: raw Unicode URI, aliases with server port, local validation and unknown")
    ss("space_hierarchy", "api/engine/client/hierarchy.ts", "api/engine/client/hierarchy.ts", "http-hierarchy",
       "federation returns immediate children and distinguishes known inaccessible from unknown")
    ss("transactions", "api/engine/federation/transaction-request.ts", "api/engine/federation/transactions.ts",
       "http-federation-transactions", "send: origin/caps and changed-body replay preserve the first per-PDU answer",
       "send: typing, receipt and presence EDUs update producer state only for the origin users")
    ss("user_devices user_keys", "api/engine/tenant/e2ee.ts", "api/engine/federation/e2ee.ts", "http-e2ee-federation",
       "authenticated own-domain snapshots and C-S/federation claims share one consuming pool")
    return bindings


def request_reviews():
    """Preserved focused consumer assertions and their independent schema pin.

    This is not a manual review completion requirement. All other parameters
    are covered mechanically by the routed source-flow guard.
    """
    reviews = {}
    bindings = {}

    def proof(key, decoder, owner, suite, cases, disposition="honored", note=""):
        bindings[key] = binding(decoder, owner, suite, cases, disposition, note, reviewed=True)
        return key

    def operation(domain, family, method, path, *groups):
        key = f"data/api/{domain}/{family}.yaml#{method} {path}"
        fields = reviews.setdefault(key, {})
        for names, selected, effect in groups:
            for name in names.split():
                if name in fields:
                    raise ValueError("duplicate semantic review: " + key + "/" + name)
                fields[name] = dict(binding=selected, effect=effect)

    def cs(family, method, path, *groups):
        operation("client-server", family, method, "/_matrix/client/" + path, *groups)

    def ss(family, method, path, *groups):
        operation("server-server", family, method, path, *groups)

    key_changes = proof("keys-changes-cuts", "api/engine/client/device-lists.ts",
                        "api/engine/server/e2ee.ts", "http-e2ee-device-lists", [
                            "self changes wake an empty account and keys/changes validates cuts",
                            "all-room sync and keys changes retain bounded old audiences through leave and rejoin"])
    cs("keys", "GET", "v3/keys/changes", (
        "query/from query/to", key_changes,
        "The exclusive from/inclusive to interval selects actual changed/left audiences; old intervals survive departure and malformed/reversed cuts fail."))
    key_timeout = proof("keys-origin-deadline", "api/engine/client/e2ee.ts",
                        "api/engine/client/e2ee.ts", "http-e2ee-federation", [
                            "query and claim deadlines retain local successes, cancel remote work and never start queued origins",
                            "the same deadline bounds admission and discovery before any consuming dial",
                            "invalid timeout is rejected before local consumption and zero timeout preserves local results"])
    for action, field in [("query", "device_keys"), ("claim", "one_time_keys")]:
        selected = proof("keys-" + action + "-selection", "api/engine/e2ee.ts",
                         "api/engine/client/e2ee.ts", "http-e2ee-federation", [
                             "authenticated own-domain snapshots and C-S/federation claims share one consuming pool",
                             "signed remote grouping preserves local successes, rejects injection and never retries consuming claims"])
        cs("keys", "POST", "v3/keys/" + action, (
            "body/application/json " + " ".join("body/application/json/" + field + suffix
                                                  for suffix in ["", "/{^@}", "/{^@}/" + ("[]" if action == "query" else "*")]),
            selected, "The requested user/device selectors reach their local or signed remote owner; query lists project devices and claim algorithms consume only their requested pool."),
           ("body/application/json/timeout", key_timeout,
            "The requested maximum bounds admission/discovery/dial; zero keeps local results, invalid values cannot consume keys and timed-out origins report failure."))

    batch = proof("batch-device-revocation", "api/engine/tenant/uia.ts",
                  "api/engine/tenant/devices.ts", "http-session", [
                      "delete_devices: UIA, ownership and batch token revocation"])
    cs("device_management", "POST", "v3/delete_devices", (
        "body/application/json body/application/json/devices body/application/json/devices/[] "
        "body/application/json/auth body/application/json/auth/allOf0 body/application/json/auth/allOf0/type "
        "body/application/json/auth/allOf0/session body/application/json/auth/allOf0/*", batch,
        "UIA gates the exact device list; both selected tokens die and the unselected caller device survives. UIA opaque stage fields cross the stage owner, not the device writer."))

    aliases = proof("room-alias-operations", "api/engine/server/aliases.ts",
                    "api/engine/client/directory.ts", "http-room-directory", [
                        "aliases: public resolve, Unicode, duplicates/syntax/domain, list access, delete power and canonical repair"])
    for method in ["GET", "DELETE"]:
        cs("directory", method, "v3/directory/room/{roomAlias}", (
            "path/roomAlias", aliases, "The decoded alias selects resolution/deletion, with Unicode, server ownership and missing-resource outcomes preserved."))
    cs("directory", "PUT", "v3/directory/room/{roomAlias}", (
        "path/roomAlias body/application/json body/application/json/room_id", aliases,
        "The alias maps to the requested room, with duplicates and membership/power checks; deleting it repairs only the affected canonical aliases."))
    cs("directory", "GET", "v3/rooms/{roomId}/aliases", (
        "path/roomId", aliases, "Only aliases of the selected room are returned through its own disclosure gate."))
    visibility = proof("room-publication-visibility", "api/engine/client/directory-request.ts",
                       "api/engine/client/directory.ts", "http-operation-directory", [
                           "omitted directory visibility defaults to public"])
    cs("list_public_rooms", "PUT", "v3/directory/list/room/{roomId}", (
        "path/roomId body/application/json body/application/json/visibility", visibility,
        "The selected room changes publication; omission means public and null is rejected. Subsequent GET observes the saved value."))

    state = proof("state-key-projection", "api/engine/client/state-request.ts",
                  "api/engine/client/state.ts", "http-operation-membership", [
                      "state format and membership enums are validated without changing their valid meanings"])
    cs("rooms", "GET", "v3/rooms/{roomId}/state/{eventType}/{stateKey}", (
        "path/roomId path/eventType path/stateKey query/format", state,
        "The room/type/state-key selects the admitted event; omitted/content format returns content, event format returns its envelope, invalid enums fail."))
    members = proof("members-at-cut", "api/endpoints/matrix/_matrix/client/v3/rooms/#roomId/members/get.ts",
                    "api/engine/client/state-admission.ts", "http-state-admission", [
                        "members at a joined-only prejoin token do not inherit a later join permission",
                        "historical members cannot reuse a shared invitation grant after an unjoined decline"])
    cs("rooms", "GET", "v3/rooms/{roomId}/members", (
        "path/roomId query/at", members,
        "The requested stream cut selects the actual historical member snapshot and its access boundary, not current state."),
       ("query/membership query/not_membership", state,
        "Membership inclusion/exclusion changes the returned member list; malformed enums are not reinterpreted as empty or unfiltered lists."))
    event = proof("single-visible-event", "api/engine/client/timeline.ts",
                  "api/engine/client/render.ts", "http-room-read", [
                      "B10 history_visibility: seven wire outcomes; left state/members/messages/context clamp"])
    cs("rooms", "GET", "v3/rooms/{roomId}/event/{eventId}", (
        "path/roomId path/eventId", event,
        "The selected event is returned only under its own room/version/visibility policy; the consumer checks exact content and room identity."))
    joined = proof("joined-member-profiles", "api/endpoints/matrix/_matrix/client/v3/rooms/#roomId/joined_members/get.ts",
                   "api/endpoints/matrix/_matrix/client/v3/rooms/#roomId/joined_members/get.ts", "http-operation-membership", [
                        "joined member summaries retain Synapse null profile strings and empty strings"])
    cs("rooms", "GET", "v3/rooms/{roomId}/joined_members", (
        "path/roomId", joined, "The selected room returns its actual joined users, preserving empty profile strings and omitting absent optional strings."))
    snapshot = proof("admitted-state-snapshot", "api/engine/client/state.ts",
                     "api/engine/client/state-admission.ts", "http-state-admission", [
                         "joined snapshots retain old state in joined-only rooms and real departures retain their cut"])
    cs("rooms", "GET", "v3/rooms/{roomId}/state", (
        "path/roomId", snapshot, "The room selects the admitted joined/departed state snapshot, never a later private publication."))

    login = proof("password-login-contract", "api/engine/tenant/session-request.ts",
                  "api/engine/tenant/users.ts", "http-session", [
                      "r0 and v3 login adapters issue usable device-bound tokens through the same session owner",
                      "registration availability, validation before UIA, inhibit_login; login/logout and logout/all"])
    initial_name = proof("initial-device-name", "api/engine/tenant/session-request.ts",
                         "api/engine/tenant/users.ts", "http-operation-account", [
                             "initial login device name cannot rename an existing device"])
    disabled_login = proof("disabled-login-branches", "api/engine/tenant/session-request.ts",
                           "api/engine/tenant/users.ts", "http-operation-preferences", [
                               "disabled login credentials never fall through to a password session"],
                           "module disabled/rejected", "Only password login with m.id.user/legacy user is advertised. Token, associated-3PID and phone credential branches are disabled and reject before device/session publication; extra fields do not override a supported identifier.")
    refresh = proof("login-refresh-support", "api/engine/tenant/session-request.ts",
                    "api/engine/tenant/users.ts", "http-refresh-token", [
                        "refresh tokens: issue, rotate, revoke-old, same-device whoami"])
    cs("login", "POST", "v3/login", (
        "body/application/json body/application/json/type body/application/json/identifier "
        "body/application/json/identifier/type body/application/json/identifier/* body/application/json/user "
        "body/application/json/password body/application/json/device_id", login,
        "Password type and local user identifier select a real authenticated device session. Unsupported types/identifiers are rejected, not interpreted as password credentials."),
       ("body/application/json/medium body/application/json/address body/application/json/token", disabled_login,
        "When used as credentials for the token/associated-3PID branches, these fields cause rejection rather than a password session or a device. A supported identifier still has its documented precedence."),
       ("body/application/json/initial_device_display_name", initial_name,
        "An initial name applies to a new device only; a subsequent login with the same device ID cannot rename it."),
       ("body/application/json/refresh_token", refresh,
        "Refresh support requests a rotating refresh session tied to the same device; old refresh and access tokens are revoked by the observed owner."))

    no_search_lazy = proof("search-inapplicable-preferences", "api/engine/tenant/filters.ts",
                           "api/engine/client/search.ts", "http-operation-preferences", [
                               "search ignores sync-only and lazy-loading preferences without changing its admitted results"],
                           "permitted no-op", "RoomEventFilter.unread_thread_notifications only applies to /sync. The tagged lazy-loading section lists /sync, /messages and /context, not /search; redundant member delivery is permitted. Search still validates and applies its actual event/scope predicates.")
    search_prefix = "body/application/json/search_categories/room_events/filter/allOf0/allOf1/"
    cs("search", "POST", "v3/search", (
        " ".join(search_prefix + name for name in ["unread_thread_notifications", "lazy_load_members", "include_redundant_members"]),
        no_search_lazy, "Search returns the same admitted result IDs/count/state for both preference values; these fields do not select a different search stream."))

    device_upload = proof("device-key-upload", "api/engine/tenant/e2ee.ts",
                          "api/engine/tenant/e2ee.ts", "http-e2ee-keys", [
                              "upload -> another user queries exact signed material and display metadata"])
    pool_upload = proof("one-time-fallback-upload", "api/engine/tenant/e2ee.ts",
                        "api/engine/tenant/e2ee.ts", "http-e2ee-keys", [
                            "signed one-time and fallback key envelopes require signature maps before publishing any pool changes",
                            "string-valued one-time and fallback variants retain exact material and distinct consumption",
                            "overlap/conflict atomicity, FIFO, concurrent consuming claims and fallback retry"])
    device_fields = ["body/application/json"] + ["body/application/json/device_keys" + suffix for suffix in [
        "", "/allOf0", "/allOf0/user_id", "/allOf0/device_id", "/allOf0/algorithms", "/allOf0/algorithms/[]",
        "/allOf0/keys", "/allOf0/keys/*", "/allOf0/signatures", "/allOf0/signatures/{^@}", "/allOf0/signatures/{^@}/*"]]
    pool_fields = ["body/application/json/" + field + suffix
                   for field in ["one_time_keys", "fallback_keys"]
                   for suffix in ["", "/allOf0", "/allOf0/*", "/allOf0/*/oneOf0", "/allOf0/*/oneOf1",
                                  "/allOf0/*/oneOf1/key", "/allOf0/*/oneOf1/signatures", "/allOf0/*/oneOf1/signatures/{^@}"]]
    cs("keys", "POST", "v3/keys/upload", (
        " ".join(device_fields), device_upload,
        "The complete device object (identity, algorithms, key IDs/values and signatures) is returned verbatim to another user, plus display metadata; mismatched identities and incomplete shapes are refused atomically."),
       (" ".join(pool_fields), pool_upload,
        "String/signed key variants retain exact key IDs, key material and signature maps. OTKs consume FIFO once; fallback survives retry, reports used state and a replacement restores unused state. Bad signature-map shapes publish no pool changes."))

    backup_keys = proof("backup-key-granularities", "api/engine/client/key-backup.ts",
                        "api/engine/tenant/key-backup.ts", "http-e2ee-key-backup", [
                            "all granularities, isolation, opaque rooms and ordered replacement reach the HTTP consumer",
                            "validation and configured budgets reject atomically without changing etag or ciphertext"])
    backup_versions = proof("backup-version-metadata", "api/engine/client/key-backup.ts",
                            "api/engine/tenant/key-backup.ts", "http-e2ee-key-backup", [
                                "version tombstones, numeric latest, immutable algorithm and metadata-only etag"])
    for tail, paths in [("", ""), ("/{roomId}", "path/roomId"),
                        ("/{roomId}/{sessionId}", "path/roomId path/sessionId")]:
        for method in ["GET", "DELETE"]:
            cs("key_backup", method, "v3/room_keys/keys" + tail, (
                "query/version " + paths, backup_keys,
                "The explicit version/room/session selects only the caller's ciphertext at that granularity; deletion changes only the selected entries and missing granules keep their documented empty/miss shape."))
        containers = ["body/application/json"]
        if tail == "":
            containers += ["body/application/json/rooms", "body/application/json/rooms/{^!}",
                           "body/application/json/rooms/{^!}/allOf0", "body/application/json/rooms/{^!}/allOf0/sessions"]
            entry = "body/application/json/rooms/{^!}/allOf0/sessions/*"
        elif tail == "/{roomId}":
            containers += ["body/application/json/sessions"]
            entry = "body/application/json/sessions/*"
        else:
            entry = "body/application/json"
        fields = containers + [entry + suffix for suffix in [
            "", "/first_message_index", "/forwarded_count", "/is_verified", "/session_data"]
            if entry + suffix not in containers]
        cs("key_backup", "PUT", "v3/room_keys/keys" + tail, (
            "query/version " + paths + " " + " ".join(fields), backup_keys,
            "Each room/session map reaches the same owner; exact opaque session_data survives restore. Verification, first index then forwarded count choose the winner, with all-or-nothing validation and etag/count changes."))
    for method in ["GET", "DELETE"]:
        cs("key_backup", method, "v3/room_keys/version/{version}", (
            "path/version", backup_versions,
            "The version selects caller-owned metadata or a tombstone; deleting the latest reveals the numerically latest surviving version without reusing a tombstoned ID."))
    cs("key_backup", "POST", "v3/room_keys/version", (
        "body/application/json body/application/json/algorithm body/application/json/auth_data", backup_versions,
        "A nonempty immutable algorithm and opaque auth_data create a new numeric version; metadata is returned exactly and starts with empty backup counters."))
    cs("key_backup", "PUT", "v3/room_keys/version/{version}", (
        "path/version body/application/json body/application/json/algorithm body/application/json/auth_data body/application/json/version", backup_versions,
        "Path/body versions must agree and algorithm cannot change; only the selected version's auth_data changes, with no ciphertext etag increment."))

    timeline = proof("message-window-operation", "api/engine/client/timeline-request.ts",
                     "api/engine/client/timeline.ts", "http-room-read", [
                         "messages: five-part/bare stream tokens, bounds, c-token paging, filtered end, lazy members and r0"])
    for predicate in [
            dict(types=["m.room.message"], senders=["SELF"], limit=1),
            dict(not_types=["org.example.*"], not_senders=["SELF"], types=["m.room.message"]),
            dict(rooms=["!other:example.test"]), dict(not_rooms=["ROOM"]), dict(limit=0)]:
        bindings[timeline]["proofs"].append(dict(suite="http-operation-timeline",
            case="messages applies the complete shared event filter " + json.dumps(predicate, separators=(",", ":"))))
    context = proof("context-window-operation", "api/engine/client/timeline-request.ts",
                    "api/engine/client/timeline.ts", "http-room-read", [
                        "context: split, zero/default limit, filter not on pivot, state at last event, v12 id and redaction rendering"])
    cs("message_pagination", "GET", "v3/rooms/{roomId}/messages", (
        "path/roomId query/from query/to query/dir query/limit query/filter", timeline,
        "The selected room/direction/bounds produce the requested chronological window, real continuation anchors and lazy state; the complete filter applies before limit and never filters the visibility cut."))
    cs("event_context", "GET", "v3/rooms/{roomId}/context/{eventId}", (
        "path/roomId path/eventId query/limit query/filter", context,
        "The pivot remains included while limit splits the surrounding window and the filter selects surrounding events/state; zero/default limits, v12 IDs and redacted rendering retain their meanings."))
    sync_presence = proof("sync-presence-default", "api/engine/client/sync-request.ts",
                          "api/engine/syncfeed.ts", "http-operation-timeline", [
                              "sync defaults presence to online at the real presence reader"])
    sync_full = proof("sync-full-state-immediate", "api/engine/client/sync-request.ts",
                      "api/engine/syncfeed.ts", "http-operation-timeline", [
                          "full_state with since ignores the long-poll timeout"])
    bindings[sync_full]["proofs"].append(dict(suite="http-sync",
        case="long poll wakes on relevant projections and committed tenant changes, not unrelated users"))
    sync_cut = proof("sync-captured-stream-cut", "api/engine/client/sync-request.ts",
                     "api/engine/syncfeed.ts", "http-sync", [
                         "initial, incremental and full_state; global tokens; account data; revoked sync token",
                         "state_after uses the publication end, retains timeline state, and obeys filters and departure"])
    sync_filter = proof("sync-resolved-filter", "api/engine/tenant/filters.ts",
                        "api/engine/syncfeed.ts", "http-sync-filter-contract", [
                            "inline and stored streams filter before limits and retain independent cuts"])
    cs("sync", "GET", "v3/sync", (
        "query/since query/use_state_after", sync_cut,
        "The captured since cut bounds incremental streams; state_after changes the response key and selects the exact publication/departure end, including already-timelined state."),
       ("query/full_state query/timeout", sync_full,
        "Full state with a since token returns the full admitted state immediately, ignoring the supplied long-poll timeout; ordinary polling retains its separate absolute deadline."),
       ("query/set_presence", sync_presence,
        "Absent presence normalizes to online; explicit presence is applied to the actual reader rather than being lost in the adapter."),
       ("query/filter", sync_filter,
        "Inline and stored filters select the same actual streams before limits while keeping independent stream cuts and federation/client event format."))
    return reviews, bindings


def generate():
    manifest_bytes = (ROOT / "tests/fixtures/spec-contracts-v1.16.json").read_bytes()
    manifest = json.loads(manifest_bytes)
    endpoints = json.loads((ROOT / "tests/fixtures/versions-endpoints.json").read_text())
    endpoint_map = {e["file"] + "#" + e["method"] + " " + e["path"]: e for e in endpoints}
    bindings = reviewed_bindings()
    reviews, semantic_bindings = request_reviews()
    reviewed_requests = [dict(id=op["id"], request=[field for field in op["request"]
                         if field["field"] in reviews.get(op["id"], {})])
                         for op in manifest["operations"] if op["id"] in reviews]
    reviewed_digest = hashlib.sha256(json.dumps(reviewed_requests, sort_keys=True,
                                                separators=(",", ":")).encode()).hexdigest()
    if reviewed_digest != REVIEWED_REQUESTS_SHA256:
        raise ValueError("reviewed request schemas changed; re-review their semantic consumer contracts")
    excluded_requests = [{key: op[key] for key in ["id", "request"]}
                         for op in manifest["operations"]
                         if endpoint_map[op["id"]]["status"] != "Routed"]
    excluded_digest = hashlib.sha256(json.dumps(excluded_requests, sort_keys=True,
                                                separators=(",", ":")).encode()).hexdigest()
    if excluded_digest != EXCLUDED_REQUESTS_SHA256:
        raise ValueError("excluded operation request contracts changed; review their refusal boundary")
    result = dict(schema=1, specCommit=manifest["specCommit"],
                   manifestSha256=hashlib.sha256(manifest_bytes).hexdigest(), bindings={}, operations=[], proseContracts=[], notApplicable={})
    result["bindings"].update(semantic_bindings)

    # Exact operation/field entries, not family/prefix exemptions. New spec
    # parameters cannot inherit an exception merely by sharing a decoder.
    def not_applicable(family, method, path, fields, reason):
        result["notApplicable"]["data/api/client-server/" + family + ".yaml#" + method + " " + path] = {
            field: reason for field in fields.split()}

    not_applicable("account_deactivation", "POST", "/_matrix/client/v3/account/deactivate",
                   "body/application/json/id_server",
                   "Identity-server binding is excluded; no associated 3PID exists to unbind. The account deactivation still performs its own authenticated revocation.")
    not_applicable("openid", "POST", "/_matrix/client/v3/user/{userId}/openid/request_token",
                   "body/application/json",
                   "The tagged request body is reserved for future use and has no declared fields; token issuance has no client body options.")
    for resource in ["user", "location"]:
        not_applicable("third_party_lookup", "GET", "/_matrix/client/v3/thirdparty/" + resource + "/{protocol}",
                       "query/fields query/fields/*",
                       "No application-service providers are configured. Any arbitrary provider-specific field map has zero matching mappings; the authenticated read truthfully returns an empty list.")
    for suffix in ["download/{serverName}/{mediaId}", "download/{serverName}/{mediaId}/{fileName}",
                   "thumbnail/{serverName}/{mediaId}"]:
        not_applicable("content-repo", "GET", "/_matrix/media/v3/" + suffix, "query/allow_remote",
                       "Legacy unauthenticated media serves local bytes only and never fetches remote media. allow_remote grants permission, not an obligation to fetch; false cannot cause a remote fetch either.")

    def special(key, value):
        result["bindings"][key] = value
        return key

    disabled_conditional = special("disabled-conditional", binding(
        "api/engine/client/membership-request.ts", "api/engine/room/create.ts",
        "http-operation-disabled", ["disabled conditional producers never publish successful writes"],
        "module disabled/rejected", "Identity-server invitations are disabled; explicit intent is rejected before a write. Empty invitation lists request no work."))
    directory = special("directory-query", binding(
        "api/engine/client/directory-request.ts", "api/engine/client/directory.ts",
        "http-remote-directory", ["GET and POST select two remote directories and preserve opaque cursors and every selector",
                                  "each directory HTTP spelling rejects all malformed known fields and local cursor suffixes"],
        note="Remote queries retain destination, cursor, text/type filters and network selection; server-server routes serve only local publication."))
    prejoin_reason = special("prejoin-departure-reason", binding(
        "api/engine/client/membership-request.ts", "api/engine/federation/invites.ts",
        "http-prejoin-reason", ["the leave adapter forwards a reason to durable departure and the sync consumer"],
        note="The client reason survives durable local departure, sync publication and the frozen signed federation leave; absent and empty reasons stay distinct."))
    result["bindings"][prejoin_reason]["proofs"].append(dict(
        suite="prejoin-lifecycle",
        case="prejoin reason: invite and knock departures persist and send the user reason, including empty"))
    filter_consumer = special("filter-streams", binding(
        "api/engine/tenant/filters.ts", "api/engine/syncfeed.ts", "http-sync-filter-contract",
        ["inline and stored streams filter before limits and retain independent cuts"]))
    media_preferences = special("media-preferences", binding(
        "api/engine/media/thumbnail.ts", "api/engine/media/service.ts", "http-operation-preferences",
        ["media waiting, redirect and animation preferences permit immediate static answers"],
        "permitted no-op", "timeout_ms MAY return early; allow_redirect grants permission, not a duty; animated=true is a supported-if-possible preference. Static thumbnails never violate animated=false."))
    preview_time = special("preview-time", binding(
        "api/engine/preview/index.ts", "api/engine/preview/index.ts", "http-operation-preferences",
        ["preview time permits the current preview through both adapters"],
        "permitted no-op", "The tagged ts description permits a newer preview when the preferred version is unavailable."))
    filter_superset = special("filter-superset", binding(
        "api/engine/tenant/filters.ts", "api/engine/syncfeed.ts", "http-operation-preferences",
        ["stored event projection and redundancy preferences preserve the permitted superset"],
        "permitted no-op", "event_fields explicitly permits extra fields; redundant member delivery is always allowed. Values remain validated and stored verbatim."))
    refresh_support = special("register-refresh-support", binding(
        "api/engine/tenant/session-request.ts", "api/engine/tenant/users.ts", "http-operation-preferences",
        ["registration refresh_token declares support but does not require a refresh token"],
        "permitted no-op", "The tagged registration refresh_token declares client support, not mandatory server issuance. Login refresh support is honored separately."))
    omit_members = special("join-full-snapshot", binding(
        "api/endpoints/matrix/_matrix/federation/v2/send_join/#roomId/#eventId/put.ts", "api/engine/federation/joins.ts",
        "http-operation-preferences", ["send_join may return the full snapshot when omit_members is offered"],
        "permitted no-op", "omit_members=true advertises ability to accept a reduced response; the full response remains valid."))
    for op in manifest["operations"]:
        endpoint = endpoint_map[op["id"]]
        family = op["id"].split("#")[0]
        if endpoint["status"] != "Routed":
            value = binding("api/endpoints/matrix/_matrix/404.ts", "api/endpoints/matrix/_matrix/404.ts",
                             "http-operation-disabled", ["excluded operations never manufacture successful actions"],
                             "module disabled/rejected", endpoint["reason"], reviewed=True)
        else:
            if family not in bindings:
                raise ValueError("unreviewed operation family: " + family)
            value = bindings[family]
        key = family + ("#excluded" if endpoint["status"] != "Routed" else "")
        result["bindings"][key] = value
        requests = []
        for field in op["request"]:
            selected = key
            name = field["field"]
            if endpoint["status"] == "Routed":
                if "/publicRooms" in op["path"]:
                    selected = directory
                if family.endswith("/filter.yaml") and name.startswith("body/"):
                    selected = filter_consumer
                if "content-repo.yaml" in family or family.endswith("/content_repository.yaml"):
                    if name in {"query/timeout_ms", "query/allow_redirect", "query/animated"}:
                        selected = media_preferences
                    if name == "query/ts":
                        selected = preview_time
                if family.endswith("/filter.yaml") and any("/" + node in name for node in ["event_fields", "include_redundant_members"]):
                    selected = filter_superset
                if family.endswith("/registration.yaml") and name == "body/application/json/refresh_token":
                    selected = refresh_support
                if family.endswith("/create_room.yaml") and name.startswith("body/application/json/invite_3pid"):
                    selected = disabled_conditional
                if family.endswith("/joining.yaml") and name.startswith("body/application/json/third_party_signed"):
                    selected = disabled_conditional
                if name == "query/omit_members":
                    selected = omit_members
                if family.endswith("/leaving.yaml") and name == "body/application/json/reason":
                    selected = prejoin_reason
            review = reviews.get(op["id"], {}).get(name)
            if review is not None:
                selected = review["binding"]
            elif endpoint["status"] != "Routed":
                review = dict(effect="The unavailable operation refuses the whole request before publication; no nested field is reinterpreted as an implemented action.")
            requests.append(dict(field=name, source=field["source"], binding=selected,
                                  review=review["effect"] if review else "",
                                  decoders=endpoint["routes"] or ["api/endpoints/matrix/_matrix/404.ts"]))
        result["operations"].append(dict(
            id=op["id"], routes=endpoint["routes"], status=endpoint["status"],
            request=requests, binding=key,
            response=op["response"]))
        if family.endswith("/capabilities.yaml"):
            result["proseContracts"].append(dict(id="profile-capability-legacy-flags", operation=op["id"],
                source=op["response"][0]["source"], binding=key,
                condition="When m.profile_fields is advertised, legacy m.set_displayname/m.set_avatar_url MUST match its enabled value."))
        if family.endswith("/search.yaml"):
            result["proseContracts"].append(dict(id="search-global-and-group-continuations", operation=op["id"],
                source=op["response"][0]["source"], binding=key,
                 condition="Missing next_batch means complete: rank/recent global and room/sender group pages retain real last-result cursors on nonempty pages, including terminal pages as in Synapse; the following empty page has no cursor."))
        if family.endswith("/voip.yaml"):
            result["proseContracts"].append(dict(id="unconfigured-turn-empty-read", operation=op["id"],
                source=op["response"][0]["source"], binding=key,
                condition="Approved C3 truthful empty-read contract: unconfigured TURN returns exactly {}; configured credentials retain every tagged required member.",
                priorArt="element-hq/synapse@a0b5a45c918a765e90a87873ac25e83b857509a1:synapse/rest/client/voip.py:51-82"))
    operation_fields = {op["id"]: {field["field"] for field in op["request"]} for op in manifest["operations"]}
    for operation, fields in reviews.items():
        if operation not in operation_fields or set(fields) - operation_fields[operation]:
            raise ValueError("stale per-field semantic review: " + operation)
    for value in result["bindings"].values():
        for proof in value["proofs"]:
            source = (ROOT / "tests" / (proof["suite"] + ".test.ts")).read_text()
            registration = re.search(r"httpSuite\(\s*(['\"])(.*?)\1", source)
            proof["test"] = (registration[2] + " > " if registration else "") + proof["case"]
            proof["testClass"] = "tests/http-app.ts" if registration else "tests/" + proof["suite"] + ".test.ts"
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    output = ROOT / "tests/fixtures/spec-consumption-v1.16.json"
    result = generate()
    if args.check:
        if json.loads(output.read_text()) != result:
            raise SystemExit("Request-consumption ledger differs from pinned bindings")
        print("Request-consumption ledger matches pinned bindings")
    else:
        output.write_text(json.dumps(result, indent=2, ensure_ascii=True) + "\n")
        print("Expanded", len(result["operations"]), "pinned operations")


if __name__ == "__main__":
    main()
