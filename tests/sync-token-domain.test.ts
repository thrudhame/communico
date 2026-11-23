import { assert, assertEquals } from '@std/assert';
import { Buffer } from 'node:buffer';
import {
  boundFutureToken,
  encodeStreamToken,
  parseStreamToken,
} from '#engine/client/tokens.ts';

const domain = '4c4d265a-68b9-46f2-bfe0-850dc6deeb05';
const other = '5c4d265a-68b9-46f2-bfe0-850dc6deeb05';
const cuts = {
  eSeq: 1,
  pSeq: 2,
  tSeq: 3,
  rSeq: 4,
  aSeq: 5,
  dSeq: 6,
  mSeq: 7,
  kSeq: 8,
  nSeq: 9,
  epoch: 'a'.repeat(32),
};
const legacy = encodeStreamToken(cuts);
const envelope = (value: unknown) =>
  'v1.' + Buffer.from(JSON.stringify(value)).toString('base64url');

Deno.test('stream domain: versioned tokens preserve all cuts and the existing publication identity', () => {
  const local = { ...cuts, domain };
  const wire = encodeStreamToken(local);
  assertEquals(wire, envelope([domain, legacy]));
  assertEquals(parseStreamToken(wire), local);
  assertEquals(encodeStreamToken(parseStreamToken(wire)!), wire);
  assertEquals(parseStreamToken(legacy), cuts);
  assertEquals(encodeStreamToken(cuts), legacy);
});

Deno.test('stream domain: equal numeric cuts from different stores remain distinguishable without recovery or clamping', () => {
  const local = { ...cuts, domain };
  const foreign = { ...cuts, domain: other };
  assert(encodeStreamToken(local) !== encodeStreamToken(foreign));
  assertEquals(parseStreamToken(encodeStreamToken(foreign)), foreign);
  const heads = { ...cuts, eSeq: 0 };
  const bounded = boundFutureToken(local, {
    eSeq: heads.eSeq,
    pSeq: heads.pSeq,
    rSeq: heads.rSeq,
    aSeq: heads.aSeq,
    dSeq: heads.dSeq,
    mSeq: heads.mSeq,
    kSeq: heads.kSeq,
    nSeq: heads.nSeq,
  });
  assertEquals(bounded, { ...local, eSeq: 0 });
  assertEquals(local.eSeq, 1);
});

Deno.test('stream domain: malformed, unknown-version and noncanonical envelopes cannot alias an issued receipt', () => {
  const canonical = envelope([domain, legacy]);
  const invalid = [
    canonical + '=',
    canonical.replace('v1.', 'v2.'),
    'v1.@@@',
    'v1.' + Buffer.from('not json').toString('base64url'),
    envelope(null),
    envelope({ domain, token: legacy }),
    envelope([domain]),
    envelope([domain, legacy, 'extra']),
    envelope(['', legacy]),
    envelope(['another-store', legacy]),
    envelope([domain.toUpperCase(), legacy]),
    envelope([domain, 's1']),
    envelope([domain, 's9007199254740992']),
    envelope([domain, 's1_z' + 'x'.repeat(32)]),
    envelope([domain, canonical]),
    'v1.' + Buffer.from(JSON.stringify([domain, legacy], null, 2)).toString(
      'base64url',
    ),
  ];
  for (const wire of invalid) assertEquals(parseStreamToken(wire), null, wire);
});

Deno.test('stream domain: optional legacy components do not acquire an identity from parsing', () => {
  const parsed = parseStreamToken('s1');
  assertEquals(parsed, {
    eSeq: 1,
    pSeq: 0,
    tSeq: 0,
    rSeq: 0,
    aSeq: 0,
    dSeq: 0,
    mSeq: 0,
    kSeq: 0,
  });
});
