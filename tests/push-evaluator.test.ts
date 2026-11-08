import { assertEquals } from '@std/assert';
import {
  evaluate,
  globMatch,
  matchesCondition,
  propertyAt,
  type PushContext,
} from '#engine/push/evaluate.ts';
import { defaultRules, type Ruleset } from '#engine/push/defaults.ts';

const user = '@bob:localhost';
const context: PushContext = {
  event: {
    type: 'm.room.message',
    sender: '@alice:localhost',
    room_id: '!r:localhost',
    content: { body: 'Hello Bob!', msgtype: 'm.text' },
  },
  userId: user,
  displayName: 'Bob',
  joinedCount: 2,
  senderPower: 50,
  notificationPower: { room: 50 },
};

Deno.test('push: strict property paths, scalar types and all condition kinds', () => {
  const event = {
    ...context.event,
    content: {
      'm.mentions': { user_ids: [user], room: true },
      'slash\\key': { value: null },
      'unknown\\q': true,
      flag: true,
      number: 1,
      values: [null, false, '1', 1, {}, []],
      body: 'Hello Bob!',
    },
  };
  const ctx = { ...context, event };
  assertEquals(propertyAt(event, 'content.m\\.mentions.user_ids'), [user]);
  assertEquals(propertyAt(event, 'content.slash\\\\key.value'), null);
  assertEquals(propertyAt(event, 'content.unknown\\q'), true);
  assertEquals(propertyAt(event, 'content.absent'), undefined);
  assertEquals(propertyAt(event, 'content.__proto__'), undefined);
  const vectors: [unknown, boolean][] = [
    [{ kind: 'event_match', key: 'content.body', pattern: 'bob' }, true],
    [{ kind: 'event_match', key: 'content.flag', pattern: '*' }, false],
    [{ kind: 'event_match', key: 'sender', pattern: '@ALICE:*' }, true],
    [{ kind: 'event_match', key: 'sender', pattern: 'alice' }, false],
    [{ kind: 'event_property_is', key: 'content.flag', value: true }, true],
    [{ kind: 'event_property_is', key: 'content.flag', value: 1 }, false],
    [{ kind: 'event_property_is', key: 'content.number', value: '1' }, false],
    [{ kind: 'event_property_is', key: 'content.absent', value: null }, false],
    [{
      kind: 'event_property_is',
      key: 'content.slash\\\\key.value',
      value: null,
    }, true],
    [{ kind: 'event_property_is', key: 'content.number', value: {} }, false],
    [
      { kind: 'event_property_contains', key: 'content.values', value: null },
      true,
    ],
    [
      { kind: 'event_property_contains', key: 'content.values', value: false },
      true,
    ],
    [
      { kind: 'event_property_contains', key: 'content.values', value: {} },
      false,
    ],
    [
      { kind: 'event_property_contains', key: 'content.flag', value: true },
      false,
    ],
    [{ kind: 'contains_display_name' }, true],
    [{ kind: 'sender_notification_permission', key: 'room' }, true],
    [{ kind: 'sender_notification_permission', key: 'custom' }, true],
    [{ kind: 'sender_notification_permission' }, false],
    [{ kind: 'future_condition' }, false],
    [null, false],
  ];
  for (const [condition, expected] of vectors) {
    assertEquals(
      matchesCondition(condition, ctx),
      expected,
      JSON.stringify(condition),
    );
  }
  for (
    const [is, expected] of [
      ['2', true],
      ['==2', true],
      ['<3', true],
      ['<=2', true],
      ['>1', true],
      ['>=2', true],
      ['3', false],
      ['<2', false],
      ['!=3', false],
      ['2x', false],
      ['-2', false],
      ['1.5', false],
    ] as const
  ) {
    assertEquals(
      matchesCondition({ kind: 'room_member_count', is }, ctx),
      expected,
      is,
    );
  }
  assertEquals(
    matchesCondition({ kind: 'contains_display_name' }, {
      ...ctx,
      displayName: '',
    }),
    false,
  );
  assertEquals(
    matchesCondition({ kind: 'sender_notification_permission', key: 'room' }, {
      ...ctx,
      senderPower: 49,
    }),
    false,
  );
  assertEquals(
    matchesCondition({ kind: 'event_property_is', key: 'n', value: 1.5 }, {
      ...ctx,
      event: { n: 1.5 },
    }),
    false,
  );
  assertEquals(
    matchesCondition({
      kind: 'event_property_is',
      key: 'n',
      value: 9007199254740992,
    }, { ...ctx, event: { n: 9007199254740992 } }),
    false,
  );
});

Deno.test('push: globs have literal metacharacters, Unicode case and ASCII word boundaries', () => {
  for (
    const [value, pattern, word, expected] of [
      ['hello Bob!', 'bob', true, true],
      ['bobby', 'bob', true, false],
      ['_bob', 'bob', true, false],
      ['bob2', 'bob', true, false],
      ['bob-cat', 'bob', true, true],
      ['x ÄBC y', 'äbc', true, true],
      ['abc', 'a?c', false, true],
      ['abc', 'a*c', false, true],
      ['ac', 'a*c', false, true],
      ['a.c', 'a.c', false, true],
      ['abc', 'a.c', false, false],
      ['[a]+(b)', '[a]+(b)', false, true],
      ['bobcat', '*bob*', true, true],
      ['x', '', false, false],
      ['', '*', false, true],
      ['abc', 'a\\*', false, false],
      ['a*', 'a\\*', false, false],
      ['a\\hello', 'a\\*', false, true],
    ] as const
  ) {
    assertEquals(
      globMatch(value, pattern, word),
      expected,
      `${value}/${pattern}`,
    );
  }
  assertEquals(globMatch('a'.repeat(10000), '*a*a*a*a*a*a*a*a*b'), false);
  // A display name is a literal, never a user-controlled glob or regexp.
  assertEquals(
    matchesCondition({ kind: 'contains_display_name' }, {
      ...context,
      displayName: '*',
    }),
    false,
  );
});

Deno.test('push: first enabled match, kind order, no-op actions and normalized tweaks', () => {
  const empty = (): Ruleset => ({
    override: [],
    content: [],
    room: [],
    sender: [],
    underride: [],
  });
  const rules = empty();
  rules.underride.push({
    rule_id: 'fallback',
    default: false,
    enabled: true,
    conditions: [],
    actions: ['notify'],
  });
  rules.sender.push({
    rule_id: '@alice:localhost',
    default: false,
    enabled: true,
    actions: ['notify', 'coalesce', { set_tweak: 'highlight' }, {
      set_tweak: 'custom',
      value: 3,
    }],
  });
  assertEquals(evaluate(rules, context), {
    ruleId: '@alice:localhost',
    kind: 'sender',
    notify: true,
    highlight: true,
    actions: ['notify', { set_tweak: 'highlight' }, {
      set_tweak: 'custom',
      value: 3,
    }],
    tweaks: { highlight: true, custom: 3 },
  });
  rules.override.push({
    rule_id: 'disabled',
    default: false,
    enabled: false,
    conditions: [],
    actions: ['notify'],
  });
  rules.override.push({
    rule_id: 'unknown',
    default: false,
    enabled: true,
    conditions: [{ kind: 'unknown' }],
    actions: ['notify'],
  });
  rules.override.push({
    rule_id: 'stop',
    default: false,
    enabled: true,
    conditions: [],
    actions: ['dont_notify', 'coalesce'],
  });
  assertEquals(evaluate(rules, context)?.notify, false);
  assertEquals(evaluate(rules, context)?.ruleId, 'stop');
  assertEquals(
    evaluate(rules, { ...context, userId: '@alice:localhost' }),
    null,
  );
  assertEquals(evaluate(empty(), context), null);
});

Deno.test('push: content, room and sender rules retain kind precedence and literal identities', () => {
  const rules: Ruleset = {
    override: [],
    content: [],
    room: [],
    sender: [],
    underride: [],
  };
  const rule = { default: false, enabled: true, actions: ['notify'] };
  rules.content = [{ ...rule, rule_id: 'keyword', pattern: 'h?llo' }];
  rules.room = [{ ...rule, rule_id: '!r:localhost' }];
  rules.sender = [{ ...rule, rule_id: '@alice:localhost' }];
  assertEquals(evaluate(rules, context)?.kind, 'content');
  rules.content[0].enabled = false;
  assertEquals(evaluate(rules, context)?.kind, 'room');
  rules.room[0].rule_id = '*';
  assertEquals(evaluate(rules, context)?.kind, 'sender');
  rules.sender[0].rule_id = '*';
  assertEquals(evaluate(rules, context), null);
  rules.override = [{
    ...rule,
    rule_id: 'no-notify',
    actions: [{ set_tweak: 'highlight' }],
  }];
  assertEquals(evaluate(rules, context)?.notify, false);
  assertEquals(evaluate(rules, context)?.highlight, false);
});

Deno.test('push: v1.16 defaults, mentions presence and ciphertext envelopes', () => {
  const defaults = defaultRules(user);
  assertEquals(Object.values(defaults).flat().length, 18);
  assertEquals(
    evaluate(defaults, context)?.ruleId,
    '.m.rule.contains_display_name',
  );
  const mentioned = {
    ...context,
    event: { ...context.event, content: { body: 'Bob', 'm.mentions': {} } },
  };
  assertEquals(
    evaluate(defaults, mentioned)?.ruleId,
    '.m.rule.room_one_to_one',
  );
  const explicit = {
    ...mentioned,
    event: {
      ...mentioned.event,
      content: { 'm.mentions': { user_ids: [user] } },
    },
  };
  assertEquals(evaluate(defaults, explicit)?.highlight, true);
  const encrypted = {
    ...context,
    event: {
      ...context.event,
      type: 'm.room.encrypted',
      content: { ciphertext: 'Bob' },
    },
  };
  assertEquals(
    evaluate(defaults, encrypted)?.ruleId,
    '.m.rule.encrypted_room_one_to_one',
  );
  assertEquals(evaluate(defaults, encrypted)?.highlight, false);
  defaults.override[0].enabled = true;
  assertEquals(evaluate(defaults, context)?.ruleId, '.m.rule.master');
  assertEquals(evaluate(defaults, context)?.notify, false);
  assertEquals(defaultRules(user).override[0].enabled, false);
});
