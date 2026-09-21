// tests/rulebook/eventid-alphabet.test.ts — the v3 event-id alphabet
// (plan D9): v3 encodes the reference hash with STANDARD base64 (+ and
// / — v3.md:57-62); v4+ uses the URL-safe variant (- and _ —
// v4-event-ids.md:3-12). Same hash, different alphabet.
import { assertEquals, assertNotEquals } from '@std/assert';
import { eventIdFor } from '#engine/eventid.ts';

const PDU = {
  type: 'm.room.message',
  room_id: '!r:localhost',
  sender: '@dev:localhost',
  content: { msgtype: 'm.text', body: 'alphabet' },
  prev_events: ['$p'],
  auth_events: ['$a'],
  depth: 2,
  origin_server_ts: 1,
  hashes: { sha256: 'h' },
  signatures: {},
};

Deno.test('eventid alphabet: v3 std vs v4+ urlsafe, same hash', async () => {
  const id3 = await eventIdFor(PDU, '3');
  const id4 = await eventIdFor(PDU, '4');
  const id9 = await eventIdFor(PDU, '9');
  const id11 = await eventIdFor(PDU, '11');
  for (const id of [id3, id4, id9, id11]) {
    assertEquals(id.startsWith('$'), true);
    // 256 bits -> 43 unpadded base64 characters
    assertEquals(id.length, 44);
  }
  // v3 and v4 use the same redaction table (v1) — the digest is
  // identical; only the alphabet differs.
  const body3 = id3.slice(1);
  const body4 = id4.slice(1);
  assertEquals(body3.replaceAll('+', '-').replaceAll('/', '_'), body4);
  // v4/v9/v11 share the urlsafe alphabet but differ by redaction table
  // where the event shape differs — for this message event the v9 table
  // keeps the same keys as v1, so v4 == v9.
  assertEquals(id4, id9);
  // v11's table strips prev_state/origin/membership — absent here, so
  // the digest still matches; the id is urlsafe regardless.
  assertEquals(id4, id11);
});

Deno.test('eventid alphabet: the v3 encoding is NOT urlsafe-representable in general', async () => {
  // Find a pdu whose v3 id contains + or / — the two encodings must
  // then differ as strings.
  let sawAlphabetDifference = false;
  for (let i = 0; i < 200 && !sawAlphabetDifference; i++) {
    const pdu = { ...PDU, content: { msgtype: 'm.text', body: 'x' + i } };
    const id3 = await eventIdFor(pdu, '3');
    const id4 = await eventIdFor(pdu, '4');
    if (/[+/]/.test(id3)) {
      sawAlphabetDifference = true;
      assertNotEquals(id3, id4);
      assertEquals(/[-_]/.test(id4), true);
    }
  }
  assertEquals(sawAlphabetDifference, true);
});
