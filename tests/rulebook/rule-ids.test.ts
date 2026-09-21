// tests/rulebook/rule-ids.test.ts — the rule-numbering corpus (plan D2):
// every key resolves in every table, plus spot-checks of the known
// printed numbers across numberings (spec tag v1.16):
// - aliases rule 4 in the v1 table (v3-auth-rules.md:52-55)
// - PL structure check 10.1 (v1) vs 9.1 (v6/v10) vs 10.1 (v12)
//   (v3-auth-rules.md: 10.1; v6.md:171-174; v10.md:221-228;
//   v12.md:211-218)
// - member.unknown 4.6 (v6, v6.md:88-213) vs 4.7 (v7, v7.md:162) vs
//   4.8 (v8, v8-auth-rules.md:133)
// - knock 4.6.x (v7) vs 4.7.x (v8)
import { assertEquals } from '@std/assert';
import { RULE_ID_TABLES, ruleId } from '#engine/rulebook/rule-ids.ts';
import { V11 } from '#engine/rulebook/room-versions.ts';
import type { RoomVersionSpec } from '#engine/rulebook/types.ts';

// A spec carrying the given numbering (ruleId reads ruleNumbering and
// identifier only).
function specOf(
  ruleNumbering: RoomVersionSpec['ruleNumbering'],
): RoomVersionSpec {
  return { ...V11, identifier: ruleNumbering, ruleNumbering };
}

const NUMBERINGS = Object.keys(
  RULE_ID_TABLES,
) as RoomVersionSpec['ruleNumbering'][];

Deno.test('rule-ids: every key resolves in every table', () => {
  const keys = new Set<string>();
  for (const n of NUMBERINGS) {
    for (const k of Object.keys(RULE_ID_TABLES[n])) keys.add(k);
  }
  for (const n of NUMBERINGS) {
    const spec = specOf(n);
    for (const k of keys) {
      const id = ruleId(spec, k);
      assertEquals(typeof id, 'string', `${n}:${k} resolved`);
      assertEquals(id.length > 0, true, `${n}:${k} non-empty`);
    }
  }
});

Deno.test('rule-ids: the aliases rule is 4.x in the v1 table only', () => {
  assertEquals(ruleId(specOf('v1'), 'aliases.no_state_key'), '4.1');
  assertEquals(ruleId(specOf('v1'), 'aliases.domain_mismatch'), '4.2');
  assertEquals(ruleId(specOf('v1'), 'aliases.allow'), '4.3');
});

Deno.test('rule-ids: PL structure check per numbering', () => {
  assertEquals(ruleId(specOf('v1'), 'pl.types'), '10.1');
  assertEquals(ruleId(specOf('v6'), 'pl.types'), '9.1');
  assertEquals(ruleId(specOf('v10'), 'pl.types'), '9.1');
  assertEquals(ruleId(specOf('v11'), 'pl.types'), '9.1');
  assertEquals(ruleId(specOf('v12'), 'pl.types'), '10.1');
});

Deno.test('rule-ids: member.unknown shifts v6/v7/v8', () => {
  assertEquals(ruleId(specOf('v6'), 'member.unknown'), '4.6');
  assertEquals(ruleId(specOf('v7'), 'member.unknown'), '4.7');
  assertEquals(ruleId(specOf('v8'), 'member.unknown'), '4.8');
});

Deno.test('rule-ids: knock sub-rules per numbering', () => {
  assertEquals(ruleId(specOf('v7'), 'member.knock_rule'), '4.6.1');
  assertEquals(ruleId(specOf('v8'), 'member.knock_rule'), '4.7.1');
  assertEquals(ruleId(specOf('v10'), 'member.knock_rule'), '4.7.1');
  assertEquals(ruleId(specOf('v12'), 'member.knock_rule'), '5.7.1');
});

Deno.test('rule-ids: v12 keeps its distinct numbers', () => {
  assertEquals(ruleId(specOf('v12'), 'room_id.not_create'), '2');
  assertEquals(ruleId(specOf('v12'), 'pl.creator_in_users'), '10.4');
  assertEquals(ruleId(specOf('v12'), 'allow'), '11');
});
