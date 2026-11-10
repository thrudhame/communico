// api/engine/room/create.ts — createRoom (plan §2.6): the initial event
// sequence in the spec's order (create_room.yaml at v1.16): create,
// creator join, power levels, canonical alias, preset join rules /
// history_visibility (guest_access is never preset-emitted), initial_state,
// name, topic, invites - one initialization transaction in an unpublished
// file. The content rules are ported from the old
// createRoom; its storage side effects are not (alias/visibility rows
// belong to the server file — stage 4; remote invitee transport is the
// caller's work, 3c).
import { MatrixError } from '#engine/matrix-error.ts';
import { splitId, validEventUserId } from '#engine/ids.ts';
import { assertCanonicalNumbers } from '#engine/canonical.ts';
import { creationCreators, creationVersion } from './creation-input.ts';
import {
  parsePowerLevels,
  requiredLevel,
} from '#engine/rulebook/power-levels.ts';
import { buildCreate, buildInTx } from '#engine/room/build.ts';
import { projectAfterWrite, registerCreatedRoom } from '#engine/room/hooks.ts';
import { initializeRoom, openRoom } from '#engine/room/index.ts';
import { ingestInTx } from '#engine/room/ingest.ts';
import { withRoomLock } from '#engine/room/lock.ts';
import {
  encryptedInitialState,
  encryptionError,
} from '#engine/room/encryption-policy.ts';
import type { Signer } from '#engine/room/signer.ts';
import type { Store } from '#engine/store/index.ts';

export type CreateRoomOptions = {
  creator: string;
  creatorProfile?: { displayname?: string; avatar_url?: string };
  version?: string; // default '11'
  preset?: string; // private_chat | trusted_private_chat | public_chat
  name?: string;
  topic?: string;
  alias?: string; // the canonical alias's localpart
  initial_state?: { type: string; state_key?: string; content: unknown }[];
  invite?: string[];
  creation_content?: Record<string, unknown>;
  power_level_content_override?: Record<string, unknown>;
  is_direct?: boolean;
  visibility?: string; // public | private (default private)
};

export type CreateRoomResult = {
  roomId: string;
  createEventId: string;
  memberEventId: string;
  roomAlias?: string;
};

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const b = out[k];
    if (
      b !== null && typeof b === 'object' && !Array.isArray(b) &&
      v !== null && typeof v === 'object' && !Array.isArray(v)
    ) {
      out[k] = deepMerge(
        b as Record<string, unknown>,
        v as Record<string, unknown>,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

const ALIAS_LOCALPART_RE = /^[a-z0-9._=\-/+]+$/;

// Everything validates BEFORE the first write — a bad option is a 400,
// never a half-created room. A rulebook reject inside the sequence is a
// planner error, not a user error: it surfaces as E_CREATE_ROOM_REJECT.
export async function createRoom(
  store: Store,
  opts: CreateRoomOptions,
  signer: Signer,
): Promise<CreateRoomResult> {
  const creator = opts.creator;
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!validEventUserId(creator)) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'invalid creator');
  }
  for (
    const value of [opts.creation_content, opts.power_level_content_override]
  ) {
    if (value !== undefined && !object(value)) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'creation content and power levels must be objects',
      );
    }
  }
  for (const value of [opts.name, opts.topic, opts.alias]) {
    if (value !== undefined && typeof value !== 'string') {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'name, topic and alias must be strings',
      );
    }
  }
  if (opts.is_direct !== undefined && typeof opts.is_direct !== 'boolean') {
    throw new MatrixError(400, 'M_BAD_JSON', 'is_direct must be a boolean');
  }
  const { version, spec } = creationVersion(
    opts.version ?? '11',
    'room_version',
  );
  const visibility = opts.visibility ?? 'private';
  if (visibility !== 'public' && visibility !== 'private') {
    throw new MatrixError(
      400,
      'M_INVALID_PARAM',
      'unknown visibility: ' + visibility,
    );
  }
  const preset = opts.preset ??
    (visibility === 'public' ? 'public_chat' : 'private_chat');
  if (
    preset !== 'private_chat' && preset !== 'trusted_private_chat' &&
    preset !== 'public_chat'
  ) {
    throw new MatrixError(400, 'M_INVALID_PARAM', 'unknown preset: ' + preset);
  }
  const invite = opts.invite ?? [];
  if (!Array.isArray(invite)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'invite must be an array');
  }
  for (const u of invite) {
    if (!validEventUserId(u)) {
      throw new MatrixError(400, 'M_INVALID_PARAM', 'not a user id: ' + u);
    }
  }
  const requestedState = opts.initial_state ?? [];
  if (!Array.isArray(requestedState)) {
    throw new MatrixError(400, 'M_BAD_JSON', 'initial_state must be an array');
  }
  for (const e of requestedState) {
    if (
      typeof e?.type !== 'string' ||
      (e.state_key !== undefined && typeof e.state_key !== 'string') ||
      e.content === null || typeof e.content !== 'object' ||
      Array.isArray(e.content)
    ) {
      throw new MatrixError(
        400,
        'M_BAD_JSON',
        'initial_state entries need type + content',
      );
    }
  }
  const initialState = encryptedInitialState(
    requestedState,
    opts.creation_content?.type,
  );
  let alias: string | undefined;
  if (opts.alias !== undefined) {
    if (!ALIAS_LOCALPART_RE.test(opts.alias)) {
      throw new MatrixError(
        400,
        'M_INVALID_PARAM',
        'bad room_alias_name: ' + opts.alias,
      );
    }
    alias = '#' + opts.alias + ':' + signer.serverName;
  }

  // additional_creators (v12, create_room.yaml:163-174): trusted_private_chat
  // combines the creation_content list and the invite array, deduplicated;
  // power_level_content_override.users must not name a creator (rule 10.4).
  let additionalCreators: string[] | undefined;
  if (spec.additionalCreators) {
    const base = creationCreators(
      spec,
      opts.creation_content?.additional_creators,
    );
    const combined = preset === 'trusted_private_chat'
      ? [...new Set([...base, ...invite])]
      : base;
    creationCreators(spec, combined);
    additionalCreators = combined.length > 0 ? combined : undefined;
    const creators = [creator, ...(additionalCreators ?? [])];
    const overrideUsers = opts.power_level_content_override?.users as
      | Record<string, unknown>
      | undefined;
    if (overrideUsers !== undefined) {
      for (const u of Object.keys(overrideUsers)) {
        if (creators.includes(u)) {
          throw new MatrixError(
            400,
            'M_INVALID_PARAM',
            'power_level_content_override.users must not name a room creator',
          );
        }
      }
    }
  }

  let pl: Record<string, unknown> = {
    ban: 50,
    events: spec.creatorsHaveInfinitePower ? { 'm.room.tombstone': 150 } : {},
    events_default: 0,
    invite: 50,
    kick: 50,
    redact: 50,
    state_default: 50,
    users: spec.creatorsHaveInfinitePower ? {} : { [creator]: 100 },
    users_default: 0,
    notifications: { room: 50 },
  };
  // Synapse's creation presets: public_chat keeps the base invite power;
  // private/trusted-private chat permit ordinary members to invite. Apply
  // these before explicit overrides, independently of the final join rule.
  if (preset !== 'public_chat') pl.invite = 0;
  if (opts.power_level_content_override !== undefined) {
    pl = deepMerge(pl, opts.power_level_content_override);
  }
  if (preset === 'trusted_private_chat' && !spec.creatorsHaveInfinitePower) {
    const users = { ...(pl.users as Record<string, unknown>) };
    for (const u of invite) users[u] = 100;
    pl.users = users;
  }
  if (spec.strictCanonicalJson) {
    assertCanonicalNumbers(pl);
    assertCanonicalNumbers(opts.creation_content);
    for (const e of initialState) assertCanonicalNumbers(e.content);
  }
  if (!parsePowerLevels(pl, spec).ok) {
    throw new MatrixError(400, 'M_BAD_JSON', 'invalid power levels');
  }

  // Check the creator's effective power at every planned encryption event
  // before initializeRoom creates even an unpublished file.
  let effectivePower = pl;
  for (const event of initialState) {
    if (
      event.type === 'm.room.power_levels' && (event.state_key ?? '') === ''
    ) {
      effectivePower = event.content as Record<string, unknown>;
    }
    if (event.type !== 'm.room.encryption') continue;
    const parsed = parsePowerLevels(effectivePower, spec);
    if (!parsed.ok) {
      throw encryptionError('Invalid power levels before encryption');
    }
    const level = spec.creatorsHaveInfinitePower
      ? Infinity
      : (parsed.pl.users[creator] ?? parsed.pl.users_default);
    if (level < requiredLevel('m.room.encryption', '', parsed.pl)) {
      throw encryptionError('Creator cannot authorize required encryption');
    }
  }

  const createContent: Record<string, unknown> = {
    ...(opts.creation_content ?? {}),
  };
  delete createContent.room_version; // overwritten (create_room.yaml:167)
  delete createContent.creator; // overwritten (same; ≤10 re-adds it)
  createContent.room_version = version;
  if (spec.explicitCreator) createContent.creator = creator;
  if (spec.additionalCreators) {
    if (additionalCreators !== undefined) {
      createContent.additional_creators = additionalCreators;
    } else {
      delete createContent.additional_creators; // key absent when empty
    }
  }

  // The room id: v12 derives it from the pre-authored create (on the
  // astronomical collision with an existing room, re-author with the next
  // millisecond — old D2); the older versions mint one.
  let createPdu;
  let finalRoomId: string;
  if (spec.roomIdFromCreateEvent) {
    let ts = Date.now();
    for (;;) {
      const pdu = await buildCreate(
        { sender: creator, content: createContent, origin_server_ts: ts },
        signer,
        version,
      );
      const derived = '!' + String(pdu.event_id).slice(1);
      let exists = true;
      try {
        await openRoom(store, derived);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) exists = false;
        else throw e;
      }
      if (!exists) {
        createPdu = pdu;
        finalRoomId = derived;
        break;
      }
      ts += 1;
    }
  } else {
    finalRoomId = '!' + crypto.randomUUID() + ':' + signer.serverName;
    createPdu = await buildCreate(
      {
        sender: creator,
        content: createContent,
        roomId: finalRoomId,
      },
      signer,
      version,
    );
  }

  const created = await withRoomLock(
    finalRoomId,
    () =>
      initializeRoom(store, finalRoomId, async (tx) => {
        const send = async (
          type: string,
          stateKey: string,
          content: Record<string, unknown>,
        ): Promise<string> => {
          const pdu = await buildInTx(tx, finalRoomId, {
            type,
            sender: creator,
            state_key: stateKey,
            content,
            origin_server_ts: Date.now(),
          }, signer);
          const res = await ingestInTx(tx, finalRoomId, pdu, {
            self: signer.serverName,
            initializing: true,
          });
          if (res.standing !== 'accepted') {
            throw new Error(
              `E_CREATE_ROOM_REJECT: ${res.reason}${
                res.rule === null ? '' : ' (rule ' + res.rule + ')'
              }`,
            );
          }
          return res.eventId;
        };

        // 1. m.room.create - with the stay and every later initial event.
        const empty = await tx.materialize.newGroup(null, []);
        await tx.segments.create({ kind: 'stay', opening_group: empty });
        const res = await ingestInTx(tx, finalRoomId, createPdu, {
          self: signer.serverName,
        });
        if (res.standing !== 'accepted') {
          throw new Error('E_CREATE_ROOM_REJECT: create ' + res.reason);
        }
        const createEventId = res.eventId;

        // 2. the creator's join
        const memberEventId = await send('m.room.member', creator, {
          ...opts.creatorProfile,
          membership: 'join',
        });

        // 3. m.room.power_levels — spec defaults (every key explicit), the
        //    override deep-merged on top; trusted_private_chat PL-100s the
        //    invitees (≤11 — for v12 they are additional_creators, rule 10.4)
        await send('m.room.power_levels', '', pl);

        // 4. the canonical alias (create_room.yaml's order — before the presets)
        if (alias !== undefined) {
          await send('m.room.canonical_alias', '', { alias });
        }

        // 5. the preset events (guest_access is never preset-emitted — the
        //    table's column is the default)
        const presetEvents: [string, Record<string, unknown>][] =
          preset === 'public_chat'
            ? [
              ['m.room.join_rules', { join_rule: 'public' }],
              ['m.room.history_visibility', { history_visibility: 'shared' }],
            ]
            : [
              ['m.room.join_rules', { join_rule: 'invite' }],
              ['m.room.history_visibility', { history_visibility: 'shared' }],
            ];
        for (const [type, content] of presetEvents) {
          await send(type, '', content);
        }

        // 6. initial_state, in order (content verbatim; state_key default '')
        for (const e of initialState) {
          await send(
            e.type,
            e.state_key ?? '',
            e.content as Record<string, unknown>,
          );
        }

        // 7. name / topic — AFTER initial_state, so they override it. The topic
        //    is the rich v1.15+ form (m.room.topic.yaml: m.topic.m.text[0].body)
        if (opts.name !== undefined) {
          await send('m.room.name', '', { name: opts.name });
        }
        if (opts.topic !== undefined) {
          await send('m.room.topic', '', {
            topic: opts.topic,
            'm.topic': { 'm.text': [{ body: opts.topic }] },
          });
        }

        // 8. invites (sender: the creator); is_direct rides along when set.
        //    LOCAL invitees only — remote invitee transport is the caller's work.
        for (const u of invite) {
          if (
            splitId(u).server !== null && !u.endsWith(':' + signer.serverName)
          ) {
            continue;
          }
          await send('m.room.member', u, {
            membership: 'invite',
            ...(opts.is_direct === true ? { is_direct: true } : {}),
          });
        }

        return {
          roomId: finalRoomId,
          createEventId,
          memberEventId,
          roomAlias: alias,
        };
      }),
  );
  // Only the complete committed file is discoverable. Registry and feed
  // projection follow it; startup can recover an interrupted projection.
  await registerCreatedRoom(store, finalRoomId);
  await projectAfterWrite(store, finalRoomId);
  return created;
}
