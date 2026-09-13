// complement/continuity-verify.ts — verify a pre-restart event's signature
// against a (post-restart) tenant pubkey. Env: C_ROOM, C_EVENT, C_PUB.
// Piped into the container like continuity-query.ts. Prints
// SIGNATURE-VERIFIES or exits 1.
import pgpkg from 'pg';
import {
  b64decode,
  importPublicKeyFromRaw,
  verifyJson,
} from '#engine/signing-primitives.js';
import { redact } from '../api/engine/eventid.ts';
import { lookupRoom } from '../api/engine/room.ts';
import { withDb } from '../api/engine/db.ts';

const roomId = Deno.env.get('C_ROOM')!;
const eventId = Deno.env.get('C_EVENT')!;
const pubB64 = Deno.env.get('C_PUB')!;
const room = await lookupRoom(roomId);
if (!room) throw new Error('room not found');
const pdu = await withDb(room.dbName, async (c) => {
  const tips = await c.query(
    "SELECT name FROM dolt.branches WHERE name LIKE 'x%' ORDER BY latest_commit_date DESC LIMIT 1;",
  );
  await c.query(`SELECT DOLT_CHECKOUT('${String(tips.rows[0].name)}');`);
  const r = await c.query('SELECT canonical_json FROM events WHERE event_id = $1;', [eventId]);
  const v = r.rows[0].canonical_json;
  return typeof v === 'string' ? JSON.parse(v) : v;
});
const redacted = redact(pdu, '11');
redacted.signatures = pdu.signatures;
const srv = Object.keys(pdu.signatures)[0];
const kid = Object.keys(pdu.signatures[srv])[0];
const pub = await importPublicKeyFromRaw(b64decode(pubB64));
const ok = await verifyJson(redacted, srv, kid, pub);
console.log(ok ? 'SIGNATURE-VERIFIES' : 'SIGNATURE-BROKEN');
if (!ok) Deno.exit(1);
