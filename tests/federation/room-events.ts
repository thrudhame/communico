// tests/federation/room-events.ts — shared helpers for the M5b native
// suites: build remote-signed events for a LOCAL room (hash, id,
// redact-then-sign with a fake server's key) and land a remote member
// join in it.
import { ingestEvent } from '#engine/ingest.ts';
import { lookupRoom, stateAtSeq } from '#engine/room.ts';
import { serverDb, withDb } from '#engine/db.ts';
import { contentHashOf, signJson } from '#engine/signing-primitives.js';
import { eventIdFor, redact } from '#engine/eventid.ts';
import type { Pdu } from '#engine/pdu.ts';

export type SigningServer = {
  name: string;
  keyId: string;
  kp: CryptoKeyPair;
};

// The stored canonical form, read AS OF the event's own commit (events
// live on their x* branches; the default branch never carries content).
export async function storedCanonicalOf(
  roomId: string,
  eventId: string,
): Promise<string> {
  const room = (await lookupRoom(roomId))!;
  return await withDb(room.dbName, async (c) => {
    const idx = await withDb(serverDb(), async (s) => {
      const r = await s.query(
        'SELECT commit_hash FROM event_index WHERE room_id = $1 AND event_id = $2;',
        [roomId, eventId],
      );
      return String(r.rows[0].commit_hash);
    });
    const r = await c.query(
      `SELECT canonical_json FROM events AS OF '${idx}' WHERE event_id = $1;`,
      [eventId],
    );
    return String(r.rows[0].canonical_json);
  });
}

// The room's create event id — the rule-2.4 minimum auth set for every
// remote event below.
export async function createIdOf(roomId: string): Promise<string> {
  const id = ((await stateAtSeq(roomId, null)) ?? []).find((r) =>
    r.type === 'm.room.create'
  )?.eventId;
  if (!id) throw new Error('no create in ' + roomId);
  return id;
}

// Build a remote event for the local room, hashed, id'd and signed with
// the given server key — the fake-remote shape the pipeline receives.
export async function remoteEvent(
  roomId: string,
  server: SigningServer,
  version: string,
  partial: {
    type: string;
    sender: string;
    content?: Record<string, unknown>;
    state_key?: string;
    prev_events: string[];
    auth_events?: string[];
    depth?: number;
    origin_server_ts?: number;
  },
): Promise<Pdu> {
  const pdu: Pdu = {
    type: partial.type,
    sender: partial.sender,
    room_id: roomId,
    content: (partial.content ?? {}) as Record<string, unknown>,
    prev_events: partial.prev_events,
    auth_events: partial.auth_events ?? [await createIdOf(roomId)],
    depth: partial.depth ?? 99,
    origin_server_ts: partial.origin_server_ts ?? Date.now(),
    hashes: { sha256: '' },
    signatures: {},
  };
  if (partial.state_key !== undefined) pdu.state_key = partial.state_key;
  const { event_id: _a, signatures: _b, hashes: _c, ...forHash } =
    pdu as unknown as Record<string, unknown>;
  void _a, void _b, void _c;
  (pdu.hashes as { sha256: string }).sha256 = await contentHashOf(forHash);
  (pdu as unknown as Record<string, unknown>).event_id = await eventIdFor(
    pdu as unknown as Record<string, unknown>,
    version,
  );
  // redact-then-sign (spec § hash_and_sign_event): the signature covers
  // the REDACTED form + hashes, so it verifies on redacted copies; the id
  // rides out-of-band (v3+ reference hashes) — never part of the payload
  const redacted = redact(pdu as unknown as Record<string, unknown>, version);
  delete redacted.event_id;
  await signJson(redacted, server.name, server.keyId, server.kp.privateKey);
  pdu.signatures = (redacted.signatures ?? {}) as Record<
    string,
    Record<string, string>
  >;
  return pdu;
}

// A remote user joins the (public) room — rule 5 needs membership before
// their messages land.
export async function remoteJoin(
  roomId: string,
  server: SigningServer,
  version: string,
  userId: string,
  prevId: string,
): Promise<string> {
  const join = await remoteEvent(roomId, server, version, {
    type: 'm.room.member',
    sender: userId,
    state_key: userId,
    content: { membership: 'join' },
    prev_events: [prevId],
  });
  await ingestEvent(roomId, join, {
    remote: { origin: server.name, position: 'after' },
  });
  return String(join.event_id);
}
