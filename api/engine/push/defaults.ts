// One v1.16 catalog for the API, sync and evaluation. v1.17 removes the
// three legacy mention rules; retain them for our v1.7-v1.16 contract.
export const PUSH_KINDS = [
  'override',
  'content',
  'room',
  'sender',
  'underride',
] as const;
export type PushKind = (typeof PUSH_KINDS)[number];
export type PushRule = {
  rule_id: string;
  actions: unknown[];
  default: boolean;
  enabled: boolean;
  conditions?: unknown[];
  pattern?: string;
};
export type Ruleset = Record<PushKind, PushRule[]>;

export function defaultRules(userId: string): Ruleset {
  const sound = { set_tweak: 'sound', value: 'default' };
  const highlight = { set_tweak: 'highlight' };
  const match = (key: string, pattern: string) => ({
    kind: 'event_match',
    key,
    pattern,
  });
  const type = (pattern: string) => match('type', pattern);
  const permission = { kind: 'sender_notification_permission', key: 'room' };
  const rule = (
    id: string,
    conditions: unknown[],
    actions: unknown[],
  ): PushRule => ({
    rule_id: '.m.rule.' + id,
    default: true,
    enabled: true,
    conditions,
    actions,
  });
  // Identity defaults use exact-property matching: MXID punctuation must not
  // accidentally become a user-supplied glob.
  const identity = (key: string) => ({
    kind: 'event_property_is',
    key,
    value: userId,
  });
  const two = { kind: 'room_member_count', is: '2' };
  const localpart = userId.slice(1, userId.indexOf(':'));
  return {
    override: [
      { ...rule('master', [], []), enabled: false },
      rule('suppress_notices', [match('content.msgtype', 'm.notice')], []),
      rule('invite_for_me', [
        type('m.room.member'),
        match('content.membership', 'invite'),
        identity('state_key'),
      ], ['notify', sound]),
      rule('member_event', [type('m.room.member')], []),
      rule('is_user_mention', [{
        kind: 'event_property_contains',
        key: 'content.m\\.mentions.user_ids',
        value: userId,
      }], ['notify', sound, highlight]),
      rule('contains_display_name', [{ kind: 'contains_display_name' }], [
        'notify',
        sound,
        highlight,
      ]),
      rule('is_room_mention', [{
        kind: 'event_property_is',
        key: 'content.m\\.mentions.room',
        value: true,
      }, permission], ['notify', highlight]),
      rule('roomnotif', [match('content.body', '@room'), permission], [
        'notify',
        highlight,
      ]),
      rule('tombstone', [type('m.room.tombstone'), match('state_key', '')], [
        'notify',
        highlight,
      ]),
      rule('reaction', [type('m.reaction')], []),
      rule('room.server_acl', [
        type('m.room.server_acl'),
        match('state_key', ''),
      ], []),
      rule('suppress_edits', [{
        kind: 'event_property_is',
        key: 'content.m\\.relates_to.rel_type',
        value: 'm.replace',
      }], []),
    ],
    content: [{
      rule_id: '.m.rule.contains_user_name',
      default: true,
      enabled: true,
      pattern: localpart,
      actions: ['notify', sound, highlight],
    }],
    room: [],
    sender: [],
    underride: [
      rule('call', [type('m.call.invite')], ['notify', {
        set_tweak: 'sound',
        value: 'ring',
      }]),
      rule('encrypted_room_one_to_one', [type('m.room.encrypted'), two], [
        'notify',
        sound,
      ]),
      rule('room_one_to_one', [type('m.room.message'), two], ['notify', sound]),
      rule('message', [type('m.room.message')], ['notify']),
      rule('encrypted', [type('m.room.encrypted')], ['notify']),
    ],
  };
}

export function effectiveRules(userId: string, stored: Ruleset): Ruleset {
  const defaults = defaultRules(userId);
  for (const kind of PUSH_KINDS) {
    const overrides = new Map(
      stored[kind].filter((r) => r.default).map((r) => [r.rule_id, r]),
    );
    const builtins = defaults[kind].map((r) => {
      const override = overrides.get(r.rule_id);
      return override
        ? { ...r, enabled: override.enabled, actions: override.actions }
        : r;
    });
    const custom = stored[kind].filter((r) => !r.default);
    defaults[kind] = kind === 'override'
      ? [builtins[0], ...custom, ...builtins.slice(1)]
      : [...custom, ...builtins];
  }
  return defaults;
}
